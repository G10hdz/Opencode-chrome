import { attachedTab, exactOrigin, mostRecentAttached, originAllowed, pollWhileAttached, serializeMutation } from "./policy.js";
import { clampSessions, sessionPorts } from "./session-config.js";

// opencode-chrome service worker: cliente WS del puente MCP + control CDP via chrome.debugger.

// 9223 lo pisan Electron apps (OpenWork/Cursor CDP). Bridge y extensión deben coincidir.
const PORT = 19223; // bridge: OPENCODE_CHROME_PORT (default en src/index.js alineado)
const RECONNECT_MS = 3000;
const CONNECTION_IDLE_MS = 45000;
const DEBUGGER_IDLE_MS = 30000; // auto-detach para que el banner "being debugged" desaparezca solo

let ws = null;
let reconnectTimer;
let connectionTimer;
let connectionAttempt = 0;
let connected = false;
let basePort = PORT;
let sessionCount = 1;
const lanes = new Map(); // port -> socket, solo cuando hay más de una sesión
const sessionNames = new Map();
const CALL_PORT = Symbol("callPort");
const refStores = new Map(); // tabId -> { refs: { [ref]: selectorCSS } } del último snapshot
const netStores = new Map(); // tabId -> { order: [requestId], byId: Map } ring buffer de red
const consoleStores = new Map(); // tabId -> { entries: [] } ring buffer de consola
const dialogStores = new Map(); // tabId -> { recent: [], pending, policy } de diálogos JS
const debuggerSessions = new Map(); // tabId -> { attach: Promise, idle: timer }
// OOPIFs = iframes cross-origin auto-attachados como sesiones hijas (flatten); el
// listener onEvent llena el registro. Sus comandos se rutean con {tabId, sessionId}.
const frameSessions = new Map(); // tabId -> Map<sessionId, {targetId, url}>
const ATTACHMENTS = "attachments";
// orígenes extra por origen de attachment (SSO redirects). La empuja el bridge al conectar
// ({policy:{origin_allowlist}}); vacío = solo origen exacto. Nace del bridge: la página
// no puede alcanzarla.
let originAllowlist = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function refreshBadges() {
  const tabs = await chrome.tabs.query({});
  const { [ATTACHMENTS]: attachments = {} } = await chrome.storage.session.get(ATTACHMENTS);
  await Promise.all(
    tabs.map((tab) => {
      const attached = attachedTab(attachments, tab.id, tab.url, originAllowlist);
      const text = connected ? (attached ? "on" : "") : "off";
      return Promise.all([
        chrome.action.setBadgeText({ tabId: tab.id, text }),
        chrome.action.setBadgeBackgroundColor({
          tabId: tab.id,
          color: connected && attached ? "#2e7d32" : "#757575",
        }),
      ]);
    })
  );
}

function setBadge(on) {
  connected = on;
  refreshBadges().catch(() => {});
}

// MV3 suspende el SW y con el mueren los timers: alarms despierta el contexto para reconectar
const KEEPALIVE_ALARM = "reconnect";

const laneTimers = new Map();
const laneRetry = new Map();

function anyOpen() {
  if (ws && ws.readyState === WebSocket.OPEN) return true;
  for (const socket of lanes.values()) if (socket.readyState === WebSocket.OPEN) return true;
  return false;
}

function syncPopup() {
  if (typeof chrome.action.setPopup !== "function") return;
  let open = 0;
  for (const socket of lanes.values()) if (socket.readyState === WebSocket.OPEN) open++;
  chrome.action.setPopup({ popup: open > 1 ? "popup.html" : "" });
}

function noteSession(msg) {
  if (!msg?.session || !Number.isInteger(msg.session.port)) return;
  const name = typeof msg.session.name === "string" ? msg.session.name.trim().slice(0, 40) : "";
  sessionNames.set(msg.session.port, name || String(msg.session.port));
}

function tagCall(args, port) {
  const next = args && typeof args === "object" ? args : {};
  if (sessionCount > 1) Object.defineProperty(next, CALL_PORT, { value: port });
  return next;
}

function dispatch(socket, port, ev, touch) {
  if (touch) touch();
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  noteSession(msg);
  if (msg && typeof msg.policy === "object" && msg.policy !== null) {
    const allow = msg.policy.origin_allowlist;
    originAllowlist = allow && typeof allow === "object" ? allow : {};
    refreshBadges().catch(() => {}); // un tab en origen allowlisted pasa a "on"
    return;
  }
  if (!msg || typeof msg.id !== "number" || typeof msg.tool !== "string") return;
  handle(msg.tool, tagCall(msg.args || {}, port))
    .then((result) => send(socket, { id: msg.id, result }))
    .catch((e) =>
      send(socket, {
        id: msg.id,
        error: {
          message: e?.message || String(e),
          error_code: e?.errorCode ?? "internal_error",
          remedy: e?.remedy ?? "retry the call; if it persists, report this message",
        },
      })
    );
}

function openSingle(token, port, attempt, announce) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  ws = socket;
  const watchConnection = (ms) => {
    clearTimeout(connectionTimer);
    connectionTimer = setTimeout(() => {
      if (ws === socket) reconnectNow();
    }, ms);
  };
  watchConnection(10000);
  socket.onopen = () => {
    if (ws !== socket) return;
    if (announce)
      socket.send(JSON.stringify({ configure: { sessions: sessionCount, port: basePort } }));
    setBadge(true);
    watchConnection(CONNECTION_IDLE_MS);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    clearTimeout(connectionTimer);
    setBadge(false);
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {}
  };
  socket.onmessage = (ev) => {
    if (ws !== socket) return;
    dispatch(socket, port, ev, () => watchConnection(CONNECTION_IDLE_MS));
  };
}

function openLane(token, port, attempt, announce) {
  const current = lanes.get(port);
  if (current && current.readyState !== WebSocket.CLOSED) return;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  lanes.set(port, socket);
  if (port === basePort) ws = socket;
  const watch = (ms) => {
    clearTimeout(laneTimers.get(port));
    laneTimers.set(
      port,
      setTimeout(() => {
        if (lanes.get(port) === socket) {
          try {
            socket.close();
          } catch {}
        }
      }, ms)
    );
  };
  watch(10000);
  socket.onopen = () => {
    if (lanes.get(port) !== socket) return;
    if (announce && port === basePort)
      socket.send(JSON.stringify({ configure: { sessions: sessionCount, port: basePort } }));
    setBadge(true);
    watch(CONNECTION_IDLE_MS);
    syncPopup();
  };
  socket.onclose = () => {
    clearTimeout(laneTimers.get(port));
    if (lanes.get(port) !== socket) return;
    lanes.delete(port);
    if (ws === socket) ws = null;
    setBadge(anyOpen());
    syncPopup();
    clearTimeout(laneRetry.get(port));
    laneRetry.set(
      port,
      setTimeout(() => {
        if (attempt !== connectionAttempt) return;
        openLane(token, port, attempt, announce);
      }, RECONNECT_MS)
    );
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {}
  };
  socket.onmessage = (ev) => {
    if (lanes.get(port) !== socket) return;
    dispatch(socket, port, ev, () => watch(CONNECTION_IDLE_MS));
  };
}

async function connect() {
  if (sessionCount <= 1 && ws && ws.readyState !== WebSocket.CLOSED) return;
  if (sessionCount > 1) {
    const planned = sessionPorts(basePort, sessionCount);
    const full = planned.every((port) => {
      const socket = lanes.get(port);
      return socket && socket.readyState !== WebSocket.CLOSED;
    });
    if (full) return;
  }
  clearTimeout(reconnectTimer);
  const attempt = ++connectionAttempt;
  const stored = await chrome.storage.local.get(["token", "port", "sessions"]);
  if (attempt !== connectionAttempt) return;
  if (!stored.token) return; // sin token configurado en las opciones no hay a quien autenticar
  basePort = Number.isInteger(stored.port) && stored.port > 0 && stored.port <= 65535 ? stored.port : PORT;
  sessionCount = clampSessions(stored.sessions);
  const announce = stored.sessions != null;
  if (sessionCount <= 1) {
    openSingle(stored.token, basePort, attempt, announce);
    return;
  }
  for (const port of sessionPorts(basePort, sessionCount)) openLane(stored.token, port, attempt, announce);
}

function reconnectNow() {
  ++connectionAttempt;
  clearTimeout(reconnectTimer);
  clearTimeout(connectionTimer);
  for (const timer of laneTimers.values()) clearTimeout(timer);
  for (const timer of laneRetry.values()) clearTimeout(timer);
  laneTimers.clear();
  laneRetry.clear();
  const previous = new Set(lanes.values());
  if (ws) previous.add(ws);
  lanes.clear();
  ws = null;
  setBadge(false);
  syncPopup();
  for (const socket of previous) {
    try {
      socket.close();
    } catch {}
  }
  connect();
}

// la página de opciones avisa al guardar el token: reconecta al instante en vez de esperar la alarm
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg === "reconnect") {
    reconnectNow();
    return;
  }
  if (msg === "status") {
    sendResponse({ connected: anyOpen() });
    return;
  }
  if (msg === "sessions") {
    const list = [];
    const seen = new Set();
    const add = (port, socket) => {
      if (!socket || socket.readyState !== WebSocket.OPEN || seen.has(port)) return;
      seen.add(port);
      list.push({ port, name: sessionNames.get(port) || String(port) });
    };
    for (const [port, socket] of lanes) add(port, socket);
    if (sessionCount <= 1) add(basePort, ws);
    sendResponse({ sessions: list });
    return true;
  }
  if (msg && typeof msg === "object" && Number.isInteger(msg.attach)) {
    toggleAttachment(msg.attach).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, message: err?.message || String(err) })
    );
    return true;
  }
});

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // CONNECTING cuenta como intento en curso; no duplicar conexiones
  if (!ws || ws.readyState === WebSocket.CLOSED) connect();
});

// Chrome arranca el worker para entregar estos eventos: es la única vía de
// reconectar tras instalar o reiniciar el navegador sin un click del usuario.
// connect() sale solo si no hay token configurado.
chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());

function send(socket, msg) {
  const live = socket === ws || [...lanes.values()].includes(socket);
  if (live && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

// Tool errors carry a machine-readable code + remedy so agents can self-heal.
function fail(errorCode, remedy, message) {
  const e = new Error(message);
  e.errorCode = errorCode;
  e.remedy = remedy;
  throw e;
}

const requireArg = (args, name) => {
  if (args[name] === undefined || args[name] === null)
    fail("missing_argument", "pass the required argument; see the tool schema", `missing argument ${name}`);
};

function callPortOf(args) {
  if (sessionCount <= 1 || !args) return null;
  const value = args[CALL_PORT];
  return Number.isInteger(value) ? value : null;
}

function visibleAttachments(attachments, port) {
  if (port == null) return attachments;
  const out = {};
  for (const [id, entry] of Object.entries(attachments || {})) {
    if (!entry || typeof entry !== "object") continue;
    const owner = Number.isInteger(entry.port) ? entry.port : basePort;
    if (owner === port) out[id] = entry;
  }
  return out;
}

function carryPort(args, extra) {
  const next = { ...(args && typeof args === "object" ? args : {}), ...extra };
  const port = args?.[CALL_PORT];
  if (Number.isInteger(port)) Object.defineProperty(next, CALL_PORT, { value: port });
  return next;
}

async function resolveTabId(args) {
  const { [ATTACHMENTS]: all = {} } = await chrome.storage.session.get(ATTACHMENTS);
  const attachments = visibleAttachments(all, callPortOf(args));
  if (args.tabId !== undefined) {
    if (typeof args.tabId !== "number")
      fail("invalid_argument", "pass a numeric tabId from list_tabs", "tabId must be a number");
    const tab = await chrome.tabs.get(args.tabId).catch(() => null);
    if (!tab || !attachedTab(attachments, tab.id, tab.url, originAllowlist))
      fail(
        "tab_not_attached",
        "attach the tab via the extension icon; if a legitimate cross-origin step navigated it (SSO), add the origin to origin_allowlist in ~/.config/opencode-chrome/policy.json",
        "tab is not attached or origin changed"
      );
    return tab.id;
  }
  const tabs = await chrome.tabs.query({});
  const recent = mostRecentAttached(attachments, tabs, originAllowlist);
  if (!recent)
    fail("no_attached_tab", "focus a tab and click the extension icon to attach it, then retry", "no attached tab");
  return recent.tab.id;
}

async function assertAttached(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const { [ATTACHMENTS]: attachments = {} } = await chrome.storage.session.get(ATTACHMENTS);
  if (!tab || !attachedTab(attachments, tabId, tab.url, originAllowlist))
    fail(
      "origin_changed",
      "the tab navigated to a different origin or was detached; re-attach it, or if this is a legitimate cross-origin step (SSO), add the origin to origin_allowlist in ~/.config/opencode-chrome/policy.json",
      "tab is no longer attached or origin changed"
    );
  return tab;
}

async function toggleAttachment(ownerPort) {
  return serializeMutation(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) fail("no_active_tab", "focus a tab and retry", "no active tab");
    const { [ATTACHMENTS]: attachments = {} } = await chrome.storage.session.get(ATTACHMENTS);
    const key = String(tab.id);
    const port = Number.isInteger(ownerPort) ? ownerPort : basePort;
    const visible = visibleAttachments(attachments, sessionCount > 1 ? port : null);
    if (attachedTab(visible, tab.id, tab.url, originAllowlist)) delete attachments[key];
    else {
      const origin = exactOrigin(tab.url);
      if (!origin)
        fail("unsupported_scheme", "only http/https tabs can be attached", "only http(s) tabs can be attached");
      const entry = { origin, attachedAt: Date.now() };
      if (sessionCount > 1) entry.port = port;
      attachments[key] = entry;
    }
    await chrome.storage.session.set({ [ATTACHMENTS]: attachments });
    await refreshBadges();
  });
}

chrome.action.onClicked.addListener(() => toggleAttachment().catch(() => {}));

// --- chrome.debugger / CDP ---

async function cdp(tabId, method, params, sessionId) {
  await assertAttached(tabId);
  const target = sessionId ? { tabId, sessionId } : { tabId };
  const result = await new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        const e = new Error(`CDP ${method}: ${err.message}`);
        e.errorCode = "cdp_error";
        e.remedy = "retry the call; if it persists, detach and re-attach the tab";
        reject(e);
      }
      else resolve(res);
    });
  });
  await assertAttached(tabId);
  return result;
}

async function ensureAttached(tabId) {
  let session = debuggerSessions.get(tabId);
  if (!session) {
    session = {};
    session.attach = new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        const err = chrome.runtime.lastError;
        if (err) {
          const e = new Error(`debugger attach: ${err.message}`);
          e.errorCode = "debugger_attach_failed";
          e.remedy = "close DevTools or any other debugger on that tab and retry";
          reject(e);
        }
        else resolve();
      });
    });
    debuggerSessions.set(tabId, session);
    session.attach.catch(() => debuggerSessions.delete(tabId));
  }
  await session.attach;
  clearTimeout(session.idle);
  // si el SW se suspende antes del timer, Chrome detacha solo al morir el contexto: aceptable v1
  session.idle = setTimeout(() => detachDebugger(tabId), DEBUGGER_IDLE_MS);
  // Network.enable una vez por sesión; el buffer lo llena el listener onEvent
  if (!session.network) {
    session.network = new Promise((resolve) => {
      chrome.debugger.sendCommand({ tabId }, "Network.enable", {}, () =>
        resolve(!chrome.runtime.lastError)
      );
    });
    await session.network;
  }
  // Page.enable una vez por sesión: habilita javascriptDialogOpening para que los
  // diálogos JS no congelen el tab mientras el debugger está attachado
  if (!session.page) {
    session.page = new Promise((resolve) => {
      chrome.debugger.sendCommand({ tabId }, "Page.enable", {}, () =>
        resolve(!chrome.runtime.lastError)
      );
    });
    await session.page;
  }
  // Runtime+Log una vez por sesión: llenan el ring buffer de consola vía onEvent
  if (!session.console) {
    session.console = Promise.all([
      new Promise((resolve) => {
        chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {}, () =>
          resolve(!chrome.runtime.lastError)
        );
      }),
      new Promise((resolve) => {
        chrome.debugger.sendCommand({ tabId }, "Log.enable", {}, () =>
          resolve(!chrome.runtime.lastError)
        );
      }),
    ]);
    await session.console;
  }
  // autoAttach flatten: los OOPIFs se attachan como sesiones hijas en este canal;
  // sus eventos y comandos viajan con sessionId en el mismo debugger
  if (!session.autoAttach) {
    session.autoAttach = new Promise((resolve) => {
      chrome.debugger.sendCommand(
        { tabId },
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        () => resolve(!chrome.runtime.lastError)
      );
    });
    await session.autoAttach;
  }
}

function frameStore(tabId) {
  let f = frameSessions.get(tabId);
  if (!f) {
    f = new Map();
    frameSessions.set(tabId, f);
  }
  return f;
}

const NET_RING_LIMIT = 100;
const CONSOLE_RING_LIMIT = 200;
const DIALOG_RING_LIMIT = 20;

function consoleStore(tabId) {
  let c = consoleStores.get(tabId);
  if (!c) {
    c = { entries: [] };
    consoleStores.set(tabId, c);
  }
  return c;
}

function pushConsole(tabId, entry) {
  const c = consoleStore(tabId);
  c.entries.push(entry);
  while (c.entries.length > CONSOLE_RING_LIMIT) c.entries.shift();
}

function dialogStore(tabId) {
  let d = dialogStores.get(tabId);
  if (!d) {
    d = { recent: [], pending: null, policy: { action: "accept" } };
    dialogStores.set(tabId, d);
  }
  return d;
}

function netStore(tabId) {
  let s = netStores.get(tabId);
  if (!s) {
    s = { order: [], byId: new Map() };
    netStores.set(tabId, s);
  }
  return s;
}

// headers se capturan ya redactados: credenciales en tránsito nunca llegan al modelo
const SENSITIVE_HEADERS = ["authorization", "cookie", "set-cookie", "proxy-authorization", "x-csrf-token", "x-xsrf-token"];
function redactHeaders(headers) {
  if (!headers || typeof headers !== "object") return undefined;
  const out = {};
  for (const [k, v] of Object.entries(headers))
    out[k] = SENSITIVE_HEADERS.includes(k.toLowerCase()) ? "[redacted]" : String(v).slice(0, 500);
  return out;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!debuggerSessions.has(tabId)) return; // solo tabs con debugger nuestro
  if (method === "Target.attachedToTarget") {
    const t = params.targetInfo;
    if (t?.type === "iframe") frameStore(tabId).set(params.sessionId, { targetId: t.targetId, url: t.url });
    return;
  }
  if (method === "Target.detachedFromTarget") {
    frameSessions.get(tabId)?.delete(params.sessionId);
    return;
  }
  if (method === "Runtime.consoleAPICalled") {
    // RemoteObject preview: value para primitivos, description para objetos
    const text = (params.args ?? [])
      .map((a) => String(a.value ?? a.description ?? a.type ?? "").slice(0, 200))
      .join(" ")
      .slice(0, 2000);
    pushConsole(tabId, { type: params.type ?? "log", source: "console", text, ts: params.timestamp });
    return;
  }
  if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails ?? {};
    pushConsole(tabId, {
      type: "error",
      source: "exception",
      text: String(d.exception?.description || d.text || "uncaught").slice(0, 2000),
      url: d.url,
      line: d.lineNumber,
      ts: params.timestamp,
    });
    return;
  }
  if (method === "Log.entryAdded") {
    const e = params.entry ?? {};
    pushConsole(tabId, {
      type: e.level === "warning" ? "warn" : e.level ?? "info",
      source: e.source ?? "log",
      text: String(e.text ?? "").slice(0, 2000),
      url: e.url,
      line: e.lineNumber,
      ts: e.timestamp,
    });
    return;
  }
  if (method === "Page.javascriptDialogOpening") {
    // un diálogo abierto bloquea CDP: se auto-responde con la política del tab (default accept)
    const d = dialogStore(tabId);
    const pending = {
      type: params.type,
      message: params.message,
      defaultPrompt: params.defaultPrompt,
      ts: Date.now(),
    };
    d.recent.push(pending);
    while (d.recent.length > DIALOG_RING_LIMIT) d.recent.shift();
    d.pending = pending;
    const resp = { accept: d.policy.action === "accept" };
    if (resp.accept && d.policy.promptText !== undefined) resp.promptText = d.policy.promptText;
    chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", resp, () => {
      pending.handled = d.policy.action;
      if (d.pending === pending) d.pending = null;
      void chrome.runtime.lastError;
    });
    return;
  }
  const s = netStore(tabId);
  if (method === "Network.requestWillBeSent") {
    s.order.push(params.requestId);
    s.byId.set(params.requestId, {
      requestId: params.requestId,
      method: params.request.method,
      url: params.request.url,
      type: params.type,
      requestHeaders: redactHeaders(params.request.headers),
      ts: params.timestamp,
      wallTime: params.wallTime,
    });
    while (s.order.length > NET_RING_LIMIT) s.byId.delete(s.order.shift());
  } else if (method === "Network.responseReceived") {
    const e = s.byId.get(params.requestId);
    if (e) {
      e.status = params.response.status;
      e.mimeType = params.response.mimeType;
      e.responseHeaders = redactHeaders(params.response.headers);
    }
  } else if (method === "Network.loadingFinished") {
    const e = s.byId.get(params.requestId);
    if (e) {
      e.size = params.encodedDataLength;
      e.endTs = params.timestamp;
    }
  }
});

function detachDebugger(tabId) {
  const session = debuggerSessions.get(tabId);
  if (!session) return;
  clearTimeout(session.idle);
  debuggerSessions.delete(tabId);
  frameSessions.delete(tabId);
  chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
}

chrome.debugger.onDetach.addListener((source) => {
  const session = debuggerSessions.get(source.tabId);
  if (session) {
    clearTimeout(session.idle);
    debuggerSessions.delete(source.tabId);
    frameSessions.delete(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  refStores.delete(tabId);
  netStores.delete(tabId);
  consoleStores.delete(tabId);
  frameSessions.delete(tabId);
  dialogStores.delete(tabId);
  detachDebugger(tabId);
  serializeMutation(() => chrome.storage.session.get(ATTACHMENTS).then(({ [ATTACHMENTS]: attachments = {} }) => {
      delete attachments[String(tabId)];
      return chrome.storage.session.set({ [ATTACHMENTS]: attachments });
  }))
    .then(refreshBadges)
    .catch(() => {});
});

// navegación invalida los refs: obliga a re-snapshot en vez de clickear selectores viejos
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status === "loading") {
    refStores.delete(tabId);
    netStores.delete(tabId);
    consoleStores.delete(tabId);
    dialogStores.delete(tabId);
    frameSessions.delete(tabId);
  }
  if (!info.url) return;
  serializeMutation(async () => {
    const { [ATTACHMENTS]: attachments = {} } = await chrome.storage.session.get(ATTACHMENTS);
    const entry = attachments[String(tabId)];
    if (entry && !originAllowed(entry.origin, info.url, originAllowlist)) {
      delete attachments[String(tabId)];
      await chrome.storage.session.set({ [ATTACHMENTS]: attachments });
      await refreshBadges();
    }
  }).catch(() => {});
});

async function evaluate(tabId, expression, sessionId) {
  const res = await cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  }, sessionId);
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    fail(
      "page_script_error",
      "the in-page evaluation failed; check the selector or page state and retry",
      `page script: ${d.exception?.description || d.text}`
    );
  }
  return res.result?.value;
}

// --- snapshot: script in-page que arma el árbol de texto y computa selectores únicos por ref ---

function SNAPSHOT_SCRIPT(opts) {
  const OPTS = opts || {};
  const MAX_LINES = 300;
  const MAX_CHARS = OPTS.maxChars > 0 ? Math.min(OPTS.maxChars, 50000) : 20000;
  const findMode = OPTS.find === true;
  const wantText = typeof OPTS.text === "string" ? OPTS.text.toLowerCase() : "";
  const wantRole = typeof OPTS.role === "string" ? OPTS.role.toLowerCase() : "";
  const root = OPTS.selector ? document.querySelector(OPTS.selector) : document;
  if (!root) return { matched_selector: false, snapshot: "", refs: {} };
  const INTERACTIVE = "a,button,input,select,textarea,[role],[onclick],[tabindex],summary";
  const TEXTY = "h1,h2,h3,h4,h5,h6,label,li,th,td,p,legend";
  const lines = ["page " + JSON.stringify(document.title) + " " + JSON.stringify(location.href)];
  const refs = {};
  let refCount = 0;
  let chars = lines[0].length;
  let overLimit = false;

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    return el.getClientRects().length > 0;
  };

  const inViewport = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };

  // texto propio = solo nodos de texto directos, evita duplicar li>p
  const ownText = (el) => {
    let s = "";
    for (const c of el.childNodes) if (c.nodeType === 3) s += c.textContent;
    return s.replace(/\s+/g, " ").trim();
  };

  // password/pago/identidad: el valor nunca sale al snapshot y los writes a su ref
  // devuelven human_takeover_required. Devuelve la razón ("password"|"cc"|"credential") o false.
  const isSensitive = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return false;
    if ((el.type || "").toLowerCase() === "password") return "password";
    if ((el.getAttribute("autocomplete") || "").toLowerCase().startsWith("cc-")) return "cc";
    const probe = [
      el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder"),
      el.labels && el.labels[0] ? el.labels[0].innerText : "",
    ].join(" ").toLowerCase().replace(/[-_]/g, " ");
    return /\b(cvv|cvc|csc|ssn|social security|security code|card verification|tax id)\b/.test(probe) ? "credential" : false;
  };

  const nameOf = (el) => {
    let name = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
    if (!name) {
      if (el.labels && el.labels[0]) name = el.labels[0].innerText;
      else if (el.type === "submit" || el.type === "button") name = el.value || "";
      else name = el.innerText || (isSensitive(el) ? "" : el.value) || el.placeholder || "";
    }
    return name.replace(/\s+/g, " ").trim().slice(0, 80);
  };

  // #id si es único; si no, path con nth-of-type desde el primer ancestro con id único (único por construcción)
  const selectorFor = (el) => {
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {
      return "#" + CSS.escape(el.id);
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };

  const hashStr = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  };

  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase();
    let role = el.getAttribute("role");
    if (!role) {
      if (tag === "a") role = "link";
      else if (tag === "button") role = "button";
      else if (tag === "select") role = "combobox";
      else if (tag === "textarea") role = "textbox";
      else if (tag === "input") {
        if (el.type === "checkbox" || el.type === "radio") role = el.type;
        else if (el.type === "submit" || el.type === "button") role = "button";
        else role = "textbox";
      } else role = tag;
    }
    return role;
  };

  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const parts = [roleOf(el)];
    const name = nameOf(el);
    if (name) parts.push(JSON.stringify(name));
    if (tag === "a" && el.getAttribute("href") != null) parts.push("href=" + JSON.stringify(el.getAttribute("href")));
    const sensitive = isSensitive(el);
    if ((tag === "input" || tag === "textarea") && el.value)
      parts.push(sensitive ? 'value="[redacted]"' : "value=" + JSON.stringify(String(el.value).slice(0, 80)));
    if (sensitive) parts.push("sensitive=" + sensitive);
    // compound controls: el envelope inline evita el round trip click→snapshot→click
    if (tag === "select") {
      const opts = [...el.options].map((o) => o.label || o.value);
      parts.push("value=" + JSON.stringify(el.value));
      parts.push("options=" + JSON.stringify(opts.slice(0, 50)));
      parts.push("options_total=" + opts.length);
    } else if (tag === "input" && el.type === "file") {
      parts.push("type=file");
      const accept = el.getAttribute("accept");
      if (accept) parts.push("accept=" + JSON.stringify(accept));
    } else if (tag === "input" && /^(date|datetime-local|month|time|week)$/.test(el.type || "")) {
      parts.push("type=" + el.type);
    }
    return parts.join(" ");
  };

  // con selector-scoping, el root mismo puede ser match (un <main> con role, etc.)
  const candidates = root.nodeType === 1 ? [root, ...root.querySelectorAll("*")] : root.querySelectorAll("*");
  let matches = 0;
  for (const el of candidates) {
    const isInteractive = el.matches(INTERACTIVE);
    if (findMode && !isInteractive) continue;
    if (overLimit && !isInteractive) continue; // pasada de recorte: solo interactivos
    if (!visible(el)) continue;
    if (OPTS.inViewportOnly && !inViewport(el)) continue;
    let line;
    if (isInteractive) {
      if (findMode) {
        if (wantRole && roleOf(el).toLowerCase() !== wantRole) continue;
        if (wantText && !(nameOf(el) + " " + ownText(el)).toLowerCase().includes(wantText)) continue;
      }
      refCount += 1;
      matches += 1;
      line = "[ref=" + refCount + "] " + describe(el);
      // fp = identidad del elemento al momento del snapshot; se verifica antes de actuar.
      // {t:tag, n:name, r:role, c:classHash} — los tiers de resolveRef usan n/t para re-identificar.
      refs[refCount] = {
        sel: selectorFor(el),
        sensitive: isSensitive(el),
        fp: {
          t: el.tagName.toLowerCase(),
          n: nameOf(el),
          r: roleOf(el),
          c: hashStr(typeof el.className === "string" ? el.className : ""),
        },
      };
    } else {
      if (findMode || OPTS.interactiveOnly || !el.matches(TEXTY)) continue;
      const txt = ownText(el);
      if (!txt) continue;
      line = el.tagName.toLowerCase() + " " + JSON.stringify(txt.slice(0, 100));
    }
    let depth = 0;
    for (let n = el; n.parentElement && n !== root; n = n.parentElement) depth++;
    lines.push("  ".repeat(Math.min(depth, 12)) + line);
    chars += line.length + 1;
    if (lines.length >= MAX_LINES || chars >= MAX_CHARS) overLimit = true;
    if (lines.length >= MAX_LINES * 2) break;
  }
  if (!findMode && overLimit) lines.push("… truncated: text content omitted, take a focused snapshot if needed");
  return { snapshot: lines.join("\n"), refs, matches };
}

// Verificacion pre-accion del fp de un ref. nameOf/roleOf/hashStr/selectorFor deben
// calcularse igual que en SNAPSHOT_SCRIPT (AGENTS.md invariant).
// Tiers: exact (sel+fp intactos) > reidentified (sel murio pero tag+name unico) >
// stable (sel resuelve pero el fp driftó) > not found.
function REF_CHECK_SCRIPT(sel, fp) {
  return `(() => {
    const FP = ${JSON.stringify(fp)};
    const SEL = ${JSON.stringify(sel)};
    const INTERACTIVE = "a,button,input,select,textarea,[role],[onclick],[tabindex],summary";
    const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
    const visible = (el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      return el.getClientRects().length > 0;
    };
    const isSensitive = (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea") return false;
      if ((el.type || "").toLowerCase() === "password") return "password";
      if ((el.getAttribute("autocomplete") || "").toLowerCase().startsWith("cc-")) return "cc";
      const probe = [
        el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder"),
        el.labels && el.labels[0] ? el.labels[0].innerText : "",
      ].join(" ").toLowerCase().replace(/[-_]/g, " ");
      return /\\b(cvv|cvc|csc|ssn|social security|security code|card verification|tax id)\\b/.test(probe) ? "credential" : false;
    };
    const nameOf = (el) => {
      let name = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
      if (!name) {
        if (el.labels && el.labels[0]) name = el.labels[0].innerText;
        else if (el.type === "submit" || el.type === "button") name = el.value || "";
        else name = el.innerText || (isSensitive(el) ? "" : el.value) || el.placeholder || "";
      }
      return name.replace(/\\s+/g, " ").trim().slice(0, 80);
    };
    const roleOf = (el) => {
      const tag = el.tagName.toLowerCase();
      let role = el.getAttribute("role");
      if (!role) {
        if (tag === "a") role = "link";
        else if (tag === "button") role = "button";
        else if (tag === "select") role = "combobox";
        else if (tag === "textarea") role = "textbox";
        else if (tag === "input") {
          if (el.type === "checkbox" || el.type === "radio") role = el.type;
          else if (el.type === "submit" || el.type === "button") role = "button";
          else role = "textbox";
        } else role = tag;
      }
      return role;
    };
    const selectorFor = (el) => {
      if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {
        return "#" + CSS.escape(el.id);
      }
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && node !== document.documentElement) {
        if (node.id && document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) {
          parts.unshift("#" + CSS.escape(node.id));
          break;
        }
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
          if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(node) + 1) + ")";
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(" > ");
    };
    const fpOf = (el) => el.tagName.toLowerCase() + "|" + nameOf(el);
    const el = document.querySelector(SEL);
    if (el && fpOf(el) === FP.t + "|" + FP.n) return { found: true, level: "exact", sel: SEL, sensitive: isSensitive(el) };
    // re-identificar: tag+name único entre los interactivos visibles; role y
    // classHash desempatan. Se evalúa aunque el selector siga resolviendo: si
    // ese elemento ya no es el de la foto, el que conserva la identidad
    // tag+name es mejor target que el impostor que ocupa su selector.
    let cands = Array.prototype.filter.call(document.querySelectorAll(INTERACTIVE), (e) =>
      visible(e) && e.tagName.toLowerCase() === FP.t && nameOf(e) === FP.n
    );
    if (cands.length > 1) cands = cands.filter((e) => roleOf(e) === FP.r);
    if (cands.length > 1) cands = cands.filter((e) => hashStr(typeof e.className === "string" ? e.className : "") === FP.c);
    if (cands.length === 1) return { found: true, level: "reidentified", sel: selectorFor(cands[0]), sensitive: isSensitive(cands[0]) };
    if (el) return { found: true, level: "stable", sel: SEL, sensitive: isSensitive(el) };
    return { found: false };
  })()`;
}

// --- tools ---

async function toolListTabs(args) {
  const tabs = await chrome.tabs.query({});
  const { [ATTACHMENTS]: all = {} } = await chrome.storage.session.get(ATTACHMENTS);
  const attachments = visibleAttachments(all, callPortOf(args));
  return { tabs: tabs.filter((t) => attachedTab(attachments, t.id, t.url, originAllowlist)).map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })) };
}

async function toolBrowserStatus(args) {
  const { [ATTACHMENTS]: all = {} } = await chrome.storage.session.get(ATTACHMENTS);
  const attachments = visibleAttachments(all, callPortOf(args));
  const tabs = await chrome.tabs.query({});
  const connected = sessionCount > 1 ? anyOpen() : !!ws && ws.readyState === WebSocket.OPEN;
  return { connected, attached: tabs.filter((t) => attachedTab(attachments, t.id, t.url, originAllowlist)).map((t) => ({ tabId: t.id, origin: attachments[String(t.id)].origin, attachedAt: attachments[String(t.id)].attachedAt })) };
}

async function toolNewTab(args) {
  const tab = await chrome.tabs.create({ url: args.url || "about:blank", active: args.background !== true });
  return { id: tab.id };
}

async function handleCloseActivate(tool, args) {
  requireArg(args, "id");
  if (typeof args.id !== "number")
    fail("invalid_argument", "pass a numeric id from list_tabs", "id must be a number");
  const tabId = await resolveTabId(carryPort(args, { tabId: args.id }));
  if (tool === "close_tab") await chrome.tabs.remove(tabId);
  else await chrome.tabs.update(tabId, { active: true });
  return {};
}

async function waitForLoad(tabId) {
  await sleep(200); // margen para que status pase a loading antes del primer chequeo
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab)
      fail("tab_closed", "the tab is gone; open a new one with new_tab or use another tabId from list_tabs", "tab was closed during navigation");
    if (tab.status === "complete") return tab;
    await sleep(250);
  }
  fail(
    "navigation_timeout",
    "the page may still be loading; retry, or poll for content with wait_for",
    "navigate: timed out waiting for load (30s)"
  );
}

async function toolNavigate(args) {
  const tabId = await resolveTabId(args);
  await assertAttached(tabId);
  const action = args.action;
  if (action !== undefined && !["back", "forward", "reload"].includes(action))
    fail("invalid_argument", "action: back, forward or reload", `navigate: bad action ${JSON.stringify(action)}`);
  if ((action ? 1 : 0) + (typeof args.url === "string" && args.url ? 1 : 0) !== 1)
    fail("invalid_argument", "pass exactly one of url or action", "navigate: needs url or action");
  // ignore_cache deshabilita el HTTP cache durante la navegación y se restaura
  // después (Page.reload también toma ignoreCache propio)
  const bypass = args.ignore_cache === true;
  // chrome.tabs.update no necesita el debugger; las acciones CDP, el snapshot
  // post-nav y el beforeunload auto-answer sí
  if (action || bypass || args.include_snapshot === true || args.handle_before_unload === true)
    await ensureAttached(tabId);
  try {
    if (bypass) await cdp(tabId, "Network.setCacheDisabled", { cacheDisabled: true });
    // handle_before_unload: al estar attached, un beforeunload entra por
    // javascriptDialogOpening y la política del tab (default accept) lo responde
    if (action === "reload") {
      await cdp(tabId, "Page.reload", { ignoreCache: bypass });
    } else if (action) {
      const hist = await cdp(tabId, "Page.getNavigationHistory");
      const entry = hist.entries?.[hist.currentIndex + (action === "back" ? -1 : 1)];
      if (!entry)
        fail("no_history", `the tab has no ${action} history entry`, `navigate: no ${action} entry in history`);
      await cdp(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
    } else {
      await chrome.tabs.update(tabId, { url: args.url });
    }
    const tab = await waitForLoad(tabId);
    // post-nav la onUpdated pudo detacher por origen: entonces no hay snapshot
    let out = { url: tab.url };
    if (args.include_snapshot === true) {
      out = await withSnapshot(tabId, undefined, args, out)
        .catch(() => ({ ...out, detached_after_nav: true }));
    }
    return out;
  } finally {
    if (bypass)
      await cdp(tabId, "Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
  }
}

// frame = targetId de list_frames o substring único de url. Un OOPIF es otra frontera de
// confianza: su origen debe estar en la allowlist del origen de attachment (igual que un
// redirect SSO). Devuelve {sessionId, targetId, url}; null si frame viene undefined.
async function resolveFrameSession(tabId, frame) {
  if (frame === undefined || frame === null) return null;
  const all = [...frameStore(tabId)].map(([sessionId, t]) => ({ sessionId, ...t }));
  let hits = all.filter((f) => f.targetId === frame);
  if (!hits.length && typeof frame === "string") hits = all.filter((f) => f.url.includes(frame));
  if (!hits.length)
    fail("frame_not_found", "run list_frames to see frame ids and urls, then retry", `frame not found: ${frame}`);
  if (hits.length > 1)
    fail("frame_not_found", "narrow the match with a frameId from list_frames", `frame is ambiguous: ${hits.map((h) => h.targetId).join(", ")}`);
  const t = hits[0];
  const { [ATTACHMENTS]: attachments = {} } = await chrome.storage.session.get(ATTACHMENTS);
  const origin = attachments[String(tabId)]?.origin;
  if (!origin || !originAllowed(origin, t.url, originAllowlist))
    fail(
      "origin_not_allowed",
      "the embedded frame's origin is not allowlisted for this tab; add it under the attached origin in ~/.config/opencode-chrome/policy.json",
      `frame origin not allowed for this tab: ${t.url}`
    );
  return t;
}

// Resuelve ref → { sel, level, sessionId }. level: exact | reidentified | stable; stale_ref si no hay match.
// Refs sensibles (password/pago/identidad) se rechazan aquí: el gate cubre toda acción por ref,
// incluidas las tools de escritura futuras que pasen por resolveRef.
async function resolveRef(tabId, ref) {
  const store = refStores.get(tabId);
  const entry = store && store.refs[ref];
  if (!entry)
    fail("stale_ref", "take a fresh snapshot and use a ref from it", "ref not found, take a new snapshot");
  if (entry.sensitive)
    fail(
      "human_takeover_required",
      "the field must be completed by the user; ask them to fill it in the page and confirm, then continue the task",
      `ref ${ref} points to a sensitive field (${entry.sensitive}); agent input is blocked`
    );
  await ensureAttached(tabId);
  const state = await evaluate(tabId, REF_CHECK_SCRIPT(entry.sel, entry.fp), store.sessionId);
  if (!state.found)
    fail("stale_ref", "take a fresh snapshot and use a ref from it", "element for this ref is gone, take a new snapshot");
  if (state.sensitive)
    fail(
      "human_takeover_required",
      "the field must be completed by the user; ask them to fill it in the page and confirm, then continue the task",
      `ref ${ref} now resolves to a sensitive field (${state.sensitive}); agent input is blocked`
    );
  if (state.sel !== entry.sel) entry.sel = state.sel; // reidentified: adopta el selector nuevo
  return { sel: state.sel, level: state.level || "exact", sessionId: store.sessionId };
}

async function toolSnapshot(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const opts = {};
  if (typeof args.selector === "string" && args.selector) opts.selector = args.selector;
  if (args.interactive_only === true) opts.interactiveOnly = true;
  if (args.in_viewport_only === true) opts.inViewportOnly = true;
  if (typeof args.max_chars === "number" && args.max_chars > 0) opts.maxChars = args.max_chars;
  const frame = await resolveFrameSession(tabId, args.frame);
  const out = await evaluate(tabId, `(${SNAPSHOT_SCRIPT})(${JSON.stringify(opts)})`, frame?.sessionId);
  if (out.matched_selector === false)
    fail(
      "element_not_found",
      "check the selector with a full snapshot or list_tabs to confirm the page",
      `snapshot: no element matches ${opts.selector}`
    );
  refStores.set(tabId, { refs: out.refs, sessionId: frame?.sessionId });
  return { snapshot: out.snapshot };
}

// find = snapshot filtrado por texto/role: devuelve solo líneas [ref=N] de matches;
// sus refs reemplazan el store (igual que un snapshot, los refs válidos son los últimos)
async function toolFind(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const opts = { find: true };
  if (typeof args.text === "string" && args.text) opts.text = args.text;
  if (typeof args.role === "string" && args.role) opts.role = args.role;
  if (!opts.text && !opts.role)
    fail("invalid_argument", "pass text and/or role", "find: needs text and/or role");
  if (typeof args.selector === "string" && args.selector) opts.selector = args.selector;
  const frame = await resolveFrameSession(tabId, args.frame);
  const out = await evaluate(tabId, `(${SNAPSHOT_SCRIPT})(${JSON.stringify(opts)})`, frame?.sessionId);
  if (out.matched_selector === false)
    fail(
      "element_not_found",
      "check the selector with a full snapshot or list_tabs to confirm the page",
      `find: no element matches ${opts.selector}`
    );
  refStores.set(tabId, { refs: out.refs, sessionId: frame?.sessionId });
  return { matches: out.matches ?? 0, snapshot: out.snapshot };
}

// read-only: scrollea hasta el fondo (hidrata secciones lazy) y devuelve innerText del selector
async function toolReadText(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const sel = typeof args.selector === "string" && args.selector ? args.selector : "body";
  const max = typeof args.max === "number" && args.max > 0 ? Math.min(args.max, 200000) : 50000;
  const scroll = args.scroll === false ? "Promise.resolve()" : `new Promise(async (done) => {
    const bottom = () => window.scrollTo(0, document.body.scrollHeight);
    for (let i = 0; i < 12; i++) { bottom(); await new Promise((r) => setTimeout(r, 500)); }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 300));
    done();
  })`;
  const frame = await resolveFrameSession(tabId, args.frame);
  const res = await cdp(tabId, "Runtime.evaluate", {
    expression: `(${scroll}).then(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.innerText.slice(0, ${max}) : null; })`,
    returnByValue: true,
    awaitPromise: true,
  }, frame?.sessionId);
  if (res.exceptionDetails)
    fail(
      "page_script_error",
      "the in-page evaluation failed; check the selector or page state and retry",
      `page script: ${res.exceptionDetails.text}`
    );
  if (res.result?.value === null || res.result?.value === undefined)
    fail("element_not_found", "check the selector, or take a snapshot to see current elements", `read_text: no element matches ${sel}`);
  return { text: res.result.value };
}

async function elementCenter(tabId, sel, sessionId) {
  return evaluate(
    tabId,
    `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      el.scrollIntoView({block:"center"});
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
      const top = document.elementFromPoint(x, y);
      return { x, y, obscured: !!top && !el.contains(top) && !top.contains(el) };
    })()`,
    sessionId
  );
}

// include_snapshot: las mutaciones cambian el DOM — devuelve el árbol fresco en
// la misma respuesta. Sus refs reemplazan el store (los previos ya no aplican).
async function withSnapshot(tabId, sessionId, args, out) {
  if (args.include_snapshot !== true) return out;
  const snap = await evaluate(tabId, `(${SNAPSHOT_SCRIPT})({})`, sessionId);
  refStores.set(tabId, { refs: snap.refs, sessionId });
  return { ...out, snapshot: snap.snapshot };
}

async function toolClick(args) {
  requireArg(args, "ref");
  const tabId = await resolveTabId(args);
  const { sel, level, sessionId } = await resolveRef(tabId, args.ref);
  const point = await elementCenter(tabId, sel, sessionId);
  if (!point)
    fail("element_not_found", "the element moved or vanished; take a new snapshot and retry", `click: element not found or not visible: ${sel}`);
  const at = { x: point.x, y: point.y, button: "left", clickCount: 1 };
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...at, clickCount: 0 }, sessionId);
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...at }, sessionId);
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...at }, sessionId);
  return withSnapshot(tabId, sessionId, args, { clicked: true, x: point.x, y: point.y, obscured: point.obscured, match_level: level });
}

async function toolHover(args) {
  requireArg(args, "ref");
  const tabId = await resolveTabId(args);
  const { sel, level, sessionId } = await resolveRef(tabId, args.ref);
  const point = await elementCenter(tabId, sel, sessionId);
  if (!point)
    fail("element_not_found", "the element moved or vanished; take a new snapshot and retry", `hover: element not found or not visible: ${sel}`);
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, sessionId);
  return withSnapshot(tabId, sessionId, args, { hovered: true, x: point.x, y: point.y, obscured: point.obscured, match_level: level });
}

async function toolDrag(args) {
  requireArg(args, "from");
  requireArg(args, "to");
  const tabId = await resolveTabId(args);
  const rf = await resolveRef(tabId, args.from);
  const rt = await resolveRef(tabId, args.to);
  // coords de cada sesión son relativas a su viewport de frame: mezclarlas sería incorrecto
  if (rf.sessionId !== rt.sessionId)
    fail("invalid_argument", "drag between different frames is not supported; use two separate interactions", "drag: refs live in different frames");
  const sessionId = rf.sessionId;
  const from = await elementCenter(tabId, rf.sel, sessionId);
  if (!from)
    fail("element_not_found", "the source element moved or vanished; take a new snapshot and retry", `drag: source ref not found or not visible`);
  const to = await elementCenter(tabId, rt.sel, sessionId);
  if (!to)
    fail("element_not_found", "the target element moved or vanished; take a new snapshot and retry", `drag: target ref not found or not visible`);
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y }, sessionId);
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 }, sessionId);
  for (let i = 1; i <= 3; i++) {
    const x = from.x + ((to.x - from.x) * i) / 3;
    const y = from.y + ((to.y - from.y) * i) / 3;
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left" }, sessionId);
  }
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 }, sessionId);
  return withSnapshot(tabId, sessionId, args, { dragged: true, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, match_level: { from: rf.level, to: rt.level } });
}

// estrategia type: focus via evaluate + Input.insertText (respeta eventos/input method), Enter como keyDown text="\r" + keyUp
async function toolType(args) {
  requireArg(args, "ref");
  requireArg(args, "text");
  const tabId = await resolveTabId(args);
  const { sel, level, sessionId } = await resolveRef(tabId, args.ref);
  await evaluate(
    tabId,
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({block:"center"}); el.focus(); return true; })()`,
    sessionId
  );
  const body = args.text.endsWith("\n") ? args.text.slice(0, -1) : args.text;
  if (body) await cdp(tabId, "Input.insertText", { text: body }, sessionId);
  if (args.text.endsWith("\n")) {
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...enter }, sessionId);
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...enter }, sessionId);
  }
  return withSnapshot(tabId, sessionId, args, { typed: true, match_level: level });
}

// fill: setter nativo del prototipo + input/change con bubbles (React/Vue
// controlled inputs no se revierten), contenteditable via textContent, y
// read-back para detectar campos que comen caracteres en silencio
async function toolFill(args) {
  requireArg(args, "ref");
  requireArg(args, "value");
  const tabId = await resolveTabId(args);
  const { sel, level, sessionId } = await resolveRef(tabId, args.ref);
  const out = await evaluate(
    tabId,
    `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return { filled: false, verified: false, actual: null, error: "not_found" };
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (el.tagName === "INPUT" && ["checkbox", "radio", "file", "hidden", "submit", "button", "reset", "image"].includes(type)) {
        return { filled: false, verified: false, actual: null, error: "unsupported_input_type:" + type };
      }
      el.scrollIntoView({ block: "center" });
      el.focus();
      const value = ${JSON.stringify(args.value)};
      if (el.isContentEditable) {
        el.textContent = value;
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        return { filled: true, verified: el.textContent === value, actual: el.textContent };
      }
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
        : el.tagName === "SELECT" ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return { filled: true, verified: el.value === value, actual: el.value };
    })()`,
    sessionId
  );
  if (!out.filled) {
    const reason = out.error || "could not set value";
    if (reason.startsWith("unsupported_input_type"))
      fail(
        "unsupported_input_type",
        "fill works on text inputs and textareas; use click for checkbox/radio and upload for file inputs",
        `fill: ${reason}`
      );
    if (reason === "not_found")
      fail("element_not_found", "the element moved or vanished; take a new snapshot and retry", `fill: ${reason}`);
    fail("fill_failed", "check the element is editable, take a new snapshot, and retry", `fill: ${reason}`);
  }
  return withSnapshot(tabId, sessionId, args, { ...out, match_level: level });
}

// select: match por label antes que por value; el error lista las opciones
// disponibles (cap 50) para que el agente reintente sin otro snapshot
async function toolSelect(args) {
  requireArg(args, "ref");
  requireArg(args, "option");
  const tabId = await resolveTabId(args);
  const { sel, level, sessionId } = await resolveRef(tabId, args.ref);
  const out = await evaluate(
    tabId,
    `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return { selected: false, error: "not_found" };
      if (el.tagName !== "SELECT") return { selected: false, error: "not_a_select:" + el.tagName.toLowerCase() };
      const want = ${JSON.stringify(args.option)};
      const opts = [...el.options];
      const opt = opts.find((o) => o.label === want) ?? opts.find((o) => o.value === want);
      if (!opt) {
        return {
          selected: false,
          error: "option_not_found",
          available: opts.map((o) => o.label || o.value).slice(0, 50),
        };
      }
      opt.selected = true;
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return { selected: true, actual: opt.value };
    })()`,
    sessionId
  );
  if (!out.selected) {
    const extra = out.available ? ` — available: ${out.available.join(", ")}` : "";
    const message = `select: ${out.error}${extra}`;
    if (out.error === "not_found")
      fail("element_not_found", "the element moved or vanished; take a new snapshot and retry", message);
    if (out.error?.startsWith("not_a_select"))
      fail("wrong_element_type", "use a ref that points to a <select> element", message);
    if (out.error === "option_not_found")
      fail("option_not_found", "pick one of the options listed in this error", message);
    fail("select_failed", "take a new snapshot and retry", message);
  }
  return withSnapshot(tabId, sessionId, args, { ...out, match_level: level });
}

// --- autofill: form_schema / apply_mapping / list_profile_keys / press_key ---
// (AUTOFILL_SPEC.md) Los valores del perfil viven en chrome.storage.local y se
// resuelven aquí dentro: por el wire solo viajan refs y nombres de key.

// Helpers duplicados de SNAPSHOT_SCRIPT a propósito (invariante AGENTS.md:
// nameOf/roleOf/selectorFor/hashStr deben calcular igual para que los refs y
// fingerprints sigan siendo válidos para fill/select/click).
function FORM_SCHEMA_SCRIPT() {
  const FIELD_SEL = 'input,select,textarea,[contenteditable="true"]';
  const NOT_FIELD = /^(hidden|submit|button|reset|image)$/;
  const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    return el.getClientRects().length > 0;
  };
  const isSensitive = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return false;
    if ((el.type || "").toLowerCase() === "password") return "password";
    if ((el.getAttribute("autocomplete") || "").toLowerCase().startsWith("cc-")) return "cc";
    const probe = [
      el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder"),
      el.labels && el.labels[0] ? el.labels[0].innerText : "",
    ].join(" ").toLowerCase().replace(/[-_]/g, " ");
    return /\b(cvv|cvc|csc|ssn|social security|security code|card verification|tax id)\b/.test(probe) ? "credential" : false;
  };
  const nameOf = (el) => {
    let name = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
    if (!name) {
      if (el.labels && el.labels[0]) name = el.labels[0].innerText;
      else if (el.type === "submit" || el.type === "button") name = el.value || "";
      else name = el.innerText || (isSensitive(el) ? "" : el.value) || el.placeholder || "";
    }
    return name.replace(/\s+/g, " ").trim().slice(0, 80);
  };
  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase();
    let role = el.getAttribute("role");
    if (!role) {
      if (tag === "a") role = "link";
      else if (tag === "button") role = "button";
      else if (tag === "select") role = "combobox";
      else if (tag === "textarea") role = "textbox";
      else if (tag === "input") {
        if (el.type === "checkbox" || el.type === "radio") role = el.type;
        else if (el.type === "submit" || el.type === "button") role = "button";
        else role = "textbox";
      } else role = tag;
    }
    return role;
  };
  const selectorFor = (el) => {
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {
      return "#" + CSS.escape(el.id);
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  // label semántico para el mapping (más rico que nameOf): <label>, aria-label,
  // aria-labelledby, placeholder, legend del fieldset, name/id como fallback
  const labelOf = (el) => {
    let label = el.labels && el.labels[0] ? el.labels[0].innerText : "";
    if (!label) label = el.getAttribute("aria-label") || "";
    if (!label) {
      const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
      label = ids.map((id) => (document.getElementById(id)?.innerText || "")).join(" ");
    }
    if (!label) label = el.placeholder || "";
    if (!label && el.closest) {
      const fs = el.closest("fieldset");
      const legend = fs && fs.querySelector("legend");
      if (legend) label = legend.innerText || "";
    }
    if (!label) label = el.name || el.id || "";
    return label.replace(/\s+/g, " ").trim().slice(0, 120);
  };
  // honeypot: invisible aunque parezca rellenable. input[type=hidden] no es
  // campo ni trampa: se omite sin contar. Bien debajo del fold no es trampa
  // (offsets negativos grandes son el patrón), un cero de tamaño tampoco.
  const offscreen = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return true;
    return r.right < -100 || r.bottom < -100;
  };
  const fields = [];
  const refs = {};
  let hiddenCount = 0;
  for (const el of document.querySelectorAll(FIELD_SEL)) {
    const tag = el.tagName.toLowerCase();
    const type = (tag === "input" ? el.type || "text" : tag).toLowerCase();
    if (tag === "input" && NOT_FIELD.test(type)) continue;
    if (!visible(el) || offscreen(el)) { hiddenCount++; continue; }
    const ref = fields.length + 1;
    const field = {
      ref,
      kind: el.isContentEditable ? "contenteditable" : type,
      label: labelOf(el),
      name: el.name || "",
      autocomplete: el.getAttribute("autocomplete") || "",
      required: !!(el.required || el.getAttribute("aria-required") === "true"),
      sensitive: isSensitive(el) || undefined,
      filled: type === "checkbox" || type === "radio" ? !!el.checked : !!el.value,
    };
    if (tag === "select") {
      const opts = [...el.options];
      field.options = opts.map((o) => o.label || o.value).slice(0, 50);
      field.options_total = opts.length;
      field.value = (opts.find((o) => o.selected) || {}).label || el.value || "";
    } else if (type === "checkbox" || type === "radio") {
      field.checked = !!el.checked;
    } else if (type === "file") {
      const accept = el.getAttribute("accept");
      if (accept) field.accept = accept;
    }
    refs[ref] = {
      sel: selectorFor(el),
      sensitive: isSensitive(el),
      fp: { t: tag, n: nameOf(el), r: roleOf(el), c: hashStr(typeof el.className === "string" ? el.className : "") },
    };
    fields.push(field);
  }
  return { fields, refs, hidden_count: hiddenCount };
}

async function toolFormSchema(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const frame = await resolveFrameSession(tabId, args.frame);
  const out = await evaluate(tabId, `(${FORM_SCHEMA_SCRIPT})({})`, frame?.sessionId);
  refStores.set(tabId, { refs: out.refs, sessionId: frame?.sessionId });
  return { fields: out.fields, hidden_count: out.hidden_count };
}

// Escritura por campo para apply_mapping: cubre select (label→value),
// checkbox/radio (truthy), contenteditable e inputs de texto. Espejo de las
// mecánicas de toolFill/toolSelect; el resultado no repite el valor escrito
// para no filtrar datos del perfil de vuelta al modelo.
function FORM_WRITE_EXPR(sel, value) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { written: false, error: "not_found" };
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const value = ${JSON.stringify(value)};
    const fire = () => {
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    };
    if (tag === "select") {
      const opts = [...el.options];
      const opt = opts.find((o) => o.label === value) ?? opts.find((o) => o.value === value);
      if (!opt) return { written: false, error: "option_not_found" };
      opt.selected = true;
      fire();
      return { written: true, kind: "select" };
    }
    if (tag === "input" && (type === "checkbox" || type === "radio")) {
      el.checked = !/^(false|0|no|off|)$/i.test(value);
      fire();
      return { written: true, kind: type };
    }
    if (el.isContentEditable) {
      el.textContent = value;
      fire();
      return { written: true, kind: "contenteditable" };
    }
    if (tag !== "input" && tag !== "textarea") return { written: false, error: "not_fillable:" + tag };
    if (/^(hidden|submit|button|reset|image)$/.test(type)) return { written: false, error: "not_fillable:" + type };
    el.scrollIntoView({ block: "center" });
    el.focus();
    const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    fire();
    return { written: true, kind: type || "text" };
  })()`;
}

async function toolApplyMapping(args) {
  requireArg(args, "mapping");
  requireArg(args, "profile");
  const tabId = await resolveTabId(args);
  // sin ensureAttached explícito: resolveRef lo hace por campo
  const { profiles = {} } = await chrome.storage.local.get("profiles");
  const profile = profiles[args.profile];
  if (!profile || typeof profile !== "object")
    fail(
      "profile_not_found",
      "seed profiles under chrome.storage.local.profiles (extension storage), then retry with list_profile_keys",
      `apply_mapping: no profile named ${JSON.stringify(args.profile)}`
    );
  const filledRefs = [];
  const failed = [];
  const unmapped = new Set();
  for (const [refKey, profileKey] of Object.entries(args.mapping)) {
    const ref = Number(refKey);
    if (!Number.isInteger(ref)) {
      failed.push({ ref: refKey, reason: "invalid_ref" });
      continue;
    }
    if (!(profileKey in profile)) {
      unmapped.add(profileKey);
      continue;
    }
    try {
      const { sel, sessionId } = await resolveRef(tabId, ref);
      const out = await evaluate(tabId, FORM_WRITE_EXPR(sel, profile[profileKey]), sessionId);
      if (out?.written) filledRefs.push(ref);
      else failed.push({ ref, reason: out?.error || "fill_failed" });
    } catch (e) {
      failed.push({ ref, reason: e.errorCode || "fill_failed" });
    }
  }
  // los refs escritos pueden haberse desplazado; el snapshot vuelve al main frame
  return withSnapshot(tabId, undefined, args, { filled: filledRefs.length, filled_refs: filledRefs, failed, unmapped_keys: [...unmapped] });
}

async function toolListProfileKeys(args) {
  requireArg(args, "profile");
  const { profiles = {} } = await chrome.storage.local.get("profiles");
  const profile = profiles[args.profile];
  return { keys: profile && typeof profile === "object" ? Object.keys(profile) : [] };
}

// Input.dispatchKeyEvent: modifiers bitmask Alt=1 Control=2 Meta=4 Shift=8.
// El texto va en el keyDown salvo con Alt/Ctrl/Meta (combos no producen texto);
// Shift solo uppercases el char.
const KEY_MOD_BITS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const KEY_NAMED = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
};
for (let i = 1; i <= 12; i++) KEY_NAMED["f" + i] = { key: "F" + i, code: "F" + i, vk: 111 + i };

function keyDef(tok, modifiers) {
  const named = KEY_NAMED[tok.toLowerCase()];
  if (named) return named;
  if (tok === " ") return KEY_NAMED.space;
  if (tok.length === 1 && tok.charCodeAt(0) > 31) {
    const up = tok.toUpperCase();
    const shift = !!(modifiers & 8);
    return {
      key: shift ? up : tok,
      code: /^[A-Z]$/i.test(tok) ? "Key" + up : /^[0-9]$/.test(tok) ? "Digit" + tok : "",
      vk: up.charCodeAt(0),
      text: shift ? up : tok,
    };
  }
  return null;
}

// press_key no pasa por resolveRef: las teclas con texto caen en el
// activeElement, así que el gate de campos sensibles se repite aquí sobre el
// foco real. isSensitive es copia idéntica de SNAPSHOT_SCRIPT/REF_CHECK_SCRIPT
// (tercer sitio — invariante AGENTS.md). "iframe" = el foco está dentro de un
// OOPIF y hay que mirar la sesión del frame; ahí sí se exige hasFocus() porque
// un frame no enfocado conserva un activeElement viejo.
function FOCUS_SENSITIVE_EXPR(requireFocus) {
  return `(() => {
    const isSensitive = (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea") return false;
      if ((el.type || "").toLowerCase() === "password") return "password";
      if ((el.getAttribute("autocomplete") || "").toLowerCase().startsWith("cc-")) return "cc";
      const probe = [
        el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder"),
        el.labels && el.labels[0] ? el.labels[0].innerText : "",
      ].join(" ").toLowerCase().replace(/[-_]/g, " ");
      return /\\b(cvv|cvc|csc|ssn|social security|security code|card verification|tax id)\\b/.test(probe) ? "credential" : false;
    };
    ${requireFocus ? "if (!document.hasFocus()) return false;" : ""}
    const el = document.activeElement;
    if (!el) return false;
    const s = isSensitive(el);
    return s || (el.tagName === "IFRAME" ? "iframe" : false);
  })()`;
}

async function toolPressKey(args) {
  requireArg(args, "key");
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const parts = String(args.key).split("+").map((s) => s.trim()).filter(Boolean);
  if (!parts.length)
    fail("invalid_argument", 'pass a key like "Enter", "Tab" or a combo like "Control+A"', "press_key: empty key");
  const tok = parts[parts.length - 1];
  let modifiers = 0;
  for (const m of parts.slice(0, -1)) {
    const bit = KEY_MOD_BITS[m.toLowerCase()];
    if (!bit)
      fail("invalid_argument", "modifiers: Alt, Control, Meta, Shift", `press_key: unknown modifier ${m}`);
    modifiers |= bit;
  }
  const def = keyDef(tok, modifiers);
  if (!def)
    fail(
      "invalid_argument",
      "named keys: Enter, Tab, Escape, Backspace, Delete, Insert, arrows, Home, End, PageUp, PageDown, Space, F1-F12; or a single printable character",
      `press_key: unknown key ${tok}`
    );
  const base = { modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk };
  const isCommand = modifiers & (1 | 2 | 4); // Alt/Control/Meta: comando, no texto
  if (def.text && !isCommand) {
    base.text = def.text;
    // gate takeover: Tab+keystrokes llenaría un password sin pasar por resolveRef
    let hit = await evaluate(tabId, FOCUS_SENSITIVE_EXPR(false));
    if (hit === "iframe") {
      hit = false;
      for (const [sessionId] of frameStore(tabId)) {
        const inner = await evaluate(tabId, FOCUS_SENSITIVE_EXPR(true), sessionId).catch(() => false);
        if (inner && inner !== "iframe") {
          hit = inner;
          break;
        }
      }
    }
    if (hit)
      fail(
        "human_takeover_required",
        "the field must be completed by the user; ask them to fill it in the page and confirm, then continue the task",
        `press_key: focused element is a sensitive field (${hit}); agent input is blocked`
      );
  }
  await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  return withSnapshot(tabId, undefined, args, { pressed: args.key });
}

async function toolScroll(args) {
  const tabId = await resolveTabId(args);
  if (args.ref !== undefined) {
    const { sel, level, sessionId } = await resolveRef(tabId, args.ref);
    const ok = await evaluate(
      tabId,
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({block:"center"}); return true; })()`,
      sessionId
    );
    if (!ok)
      fail("element_not_found", "the element moved or vanished; take a new snapshot and retry", `scroll: element not found: ${sel}`);
    return withSnapshot(tabId, sessionId, args, { scrolled: true, match_level: level });
  }
  const dx = args.dx ?? 0;
  const dy = args.dy ?? 600;
  const pos = await evaluate(
    tabId,
    `(() => { scrollBy(${JSON.stringify(dx)}, ${JSON.stringify(dy)}); return { x: scrollX, y: scrollY, maxY: document.documentElement.scrollHeight - innerHeight }; })()`
  );
  return withSnapshot(tabId, undefined, args, { scrolled: true, x: pos.x, y: pos.y, at_bottom: pos.y >= pos.maxY });
}

// upload: DOM.setFileInputFiles pone los paths directo en el input; Chrome
// (el proceso browser) lee los archivos, la extensión nunca toca el contenido
async function toolUpload(args) {
  requireArg(args, "ref");
  requireArg(args, "files");
  const tabId = await resolveTabId(args);
  const { sel, level, sessionId } = await resolveRef(tabId, args.ref);
  const kind = await evaluate(
    tabId,
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.tagName + ":" + (el.getAttribute("type") || "") : null; })()`,
    sessionId
  );
  if (!kind)
    fail("element_not_found", "the element moved or vanished; take a new snapshot and retry", `upload: element not found: ${sel}`);
  if (!/^INPUT:file$/i.test(kind))
    fail("wrong_element_type", "the ref must point to an <input type=file>", `upload: ref is not a file input (${kind})`);
  const doc = await cdp(tabId, "DOM.getDocument", {}, sessionId);
  const node = await cdp(tabId, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel }, sessionId);
  if (!node.nodeId)
    fail("element_not_found", "take a new snapshot and retry", `upload: node not found via DOM domain: ${sel}`);
  await cdp(tabId, "DOM.setFileInputFiles", { nodeId: node.nodeId, files: args.files }, sessionId);
  return withSnapshot(tabId, sessionId, args, { uploaded: args.files.length, files: args.files, match_level: level });
}

async function toolListDialogs(args) {
  const tabId = await resolveTabId(args);
  const d = dialogStores.get(tabId);
  return {
    pending: d?.pending ?? null,
    recent: d?.recent ?? [],
    policy: d?.policy ?? { action: "accept" },
  };
}

async function toolHandleDialog(args) {
  requireArg(args, "action");
  const tabId = await resolveTabId(args);
  const d = dialogStore(tabId);
  const action = args.action === "dismiss" ? "dismiss" : "accept";
  d.policy = { action };
  if (args.prompt_text !== undefined) d.policy.promptText = args.prompt_text;
  const pending = d.pending;
  if (pending) {
    const params = { accept: action === "accept" };
    if (params.accept && args.prompt_text !== undefined) params.promptText = args.prompt_text;
    await cdp(tabId, "Page.handleJavaScriptDialog", params);
    pending.handled = action;
    d.pending = null;
  }
  return { policy: d.policy, answered_pending: !!pending };
}

// console: ring buffer por tab (Runtime.consoleAPICalled + exceptionThrown +
// Log.entryAdded, llenado por onEvent). types filtra por tipo exacto,
// filter por substring del texto.
async function toolListConsoleMessages(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  let rows = consoleStores.get(tabId)?.entries ?? [];
  if (Array.isArray(args.types) && args.types.length)
    rows = rows.filter((m) => args.types.includes(m.type));
  if (args.filter) rows = rows.filter((m) => m.text.includes(args.filter));
  return { messages: rows };
}

// HAR 1.2 del buffer (post-filtros, sin paginación): headers ya vienen redactados
// del store. timings no se capturan por fase; time = requestWillBeSent→loadingFinished.
function toHar(rows) {
  const headers = (h) => Object.entries(h ?? {}).map(([name, value]) => ({ name, value }));
  const entries = rows.map((r) => ({
    startedDateTime: r.wallTime ? new Date(r.wallTime * 1000).toISOString() : null,
    time: r.endTs !== undefined && r.ts !== undefined ? Math.max(0, Math.round((r.endTs - r.ts) * 1000)) : -1,
    request: {
      method: r.method ?? "GET",
      url: r.url ?? "",
      httpVersion: "HTTP/1.1",
      headers: headers(r.requestHeaders),
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status: r.status ?? 0,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: headers(r.responseHeaders),
      content: { size: r.size ?? -1, mimeType: r.mimeType ?? "" },
      redirectURL: "",
      headersSize: -1,
      bodySize: r.size ?? -1,
    },
    cache: {},
    timings: { send: -1, wait: -1, receive: -1 },
    _resourceType: r.type,
  }));
  return JSON.stringify(
    { log: { version: "1.2", creator: { name: "opencode-chrome", version: chrome.runtime.getManifest().version }, entries } },
    null,
    2
  );
}

async function toolListNetwork(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const s = netStores.get(tabId);
  let rows = s ? s.order.map((id) => s.byId.get(id)).filter(Boolean) : [];
  if (args.filter) rows = rows.filter((r) => r.url.includes(args.filter));
  if (Array.isArray(args.resource_types) && args.resource_types.length) {
    const wanted = args.resource_types.map((t) => String(t).toLowerCase());
    rows = rows.filter((r) => r.type && wanted.includes(String(r.type).toLowerCase()));
  }
  const total = rows.length;
  // output_path sin format explícito exporta HAR (la razón de ser del flag aquí)
  if (args.format === "har" || typeof args.output_path === "string")
    return { har: toHar(rows), entries: rows.length };
  const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0;
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : total;
  rows = rows.slice(offset, offset + limit);
  if (args.include_headers !== true)
    rows = rows.map(({ requestHeaders, responseHeaders, ...r }) => r);
  return { requests: rows, total, offset };
}

// key names únicamente: los valores (tokens de sesión, PII) nunca salen del tab,
// misma frontera que list_profile_keys. null = storage inaccesible (sandbox).
async function toolListStorageKeys(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const out = await evaluate(
    tabId,
    `(() => {
      const keys = (get) => { try { return Object.keys(get()); } catch { return null; } };
      return { local_storage: keys(() => window.localStorage), session_storage: keys(() => window.sessionStorage) };
    })()`
  );
  return { local_storage: out?.local_storage ?? null, session_storage: out?.session_storage ?? null };
}

async function toolGetNetworkBody(args) {
  requireArg(args, "requestId");
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const res = await cdp(tabId, "Network.getResponseBody", { requestId: args.requestId });
  const MAX = 200_000;
  let body = res.body;
  let truncated = false;
  if (!res.base64Encoded && body.length > MAX) {
    body = body.slice(0, MAX);
    truncated = true;
  }
  return { body, base64Encoded: !!res.base64Encoded, truncated };
}

// overlay efímero con badges [N] sobre los refs del último snapshot (set-of-marks):
// los números son los refs, así la imagen se correlaciona con el snapshot directo
const MARKS_ID = "__oc_marks";
const MARKS_REMOVE = `(() => { const b = document.getElementById(${JSON.stringify(MARKS_ID)}); if (b) b.remove(); return true; })()`;
function MARKS_INJECT(marks) {
  return `(() => {
    const old = document.getElementById(${JSON.stringify(MARKS_ID)});
    if (old) old.remove();
    const box = document.createElement("div");
    box.id = ${JSON.stringify(MARKS_ID)};
    let placed = 0;
    for (const m of ${JSON.stringify(marks)}) {
      const el = document.querySelector(m.sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      const b = document.createElement("span");
      b.textContent = m.n;
      b.setAttribute("style", "position:fixed;left:" + r.left + "px;top:" + r.top + "px;z-index:2147483647;background:#111;color:#fff;font:11px monospace;padding:1px 4px;border-radius:2px;pointer-events:none;");
      box.appendChild(b);
      placed++;
    }
    document.documentElement.appendChild(box);
    return placed;
  })()`;
}

async function toolScreenshot(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  let marked = 0;
  if (args.annotate === true) {
    const store = refStores.get(tabId);
    const marks = store ? Object.entries(store.refs).map(([n, e]) => ({ n: Number(n), sel: e.sel })) : [];
    if (marks.length) marked = await evaluate(tabId, MARKS_INJECT(marks), store?.sessionId);
  }
  try {
    const res = await cdp(tabId, "Page.captureScreenshot", { format: "png" });
    return { image: res.data };
  } finally {
    if (marked) {
      const store = refStores.get(tabId);
      await evaluate(tabId, MARKS_REMOVE, store?.sessionId).catch(() => {});
    }
  }
}

async function toolWaitFor(args) {
  requireArg(args, "text");
  const texts = Array.isArray(args.text) ? args.text : [args.text];
  if (!texts.length || texts.some((t) => typeof t !== "string" || !t))
    fail("invalid_argument", "pass a non-empty string or array of strings", "wait_for: empty text");
  const timeout = typeof args.timeout === "number" ? args.timeout : 10000;
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  // array = alternativas: resuelve con el primero que aparezca
  const expr = `(() => { try { const t = (document.body && document.body.innerText) || ''; for (const s of ${JSON.stringify(texts)}) if (t.includes(s)) return s; return null; } catch { return null; } })()`;
  let matched = null;
  const found = await pollWhileAttached({
    assertAttached: () => assertAttached(tabId),
    check: async () => (matched = await evaluate(tabId, expr)) != null,
    pause: sleep,
    timeout,
  });
  if (!found)
    fail(
      "wait_timeout",
      "increase timeout, or check the text appears exactly as rendered in the page",
      `wait_for: ${texts.map((t) => JSON.stringify(t)).join(", ")} no apareció en ${timeout}ms`
    );
  return { found: true, matched };
}

// emulate: overrides de entorno por tab via Emulation/Network domains.
// Persisten mientras el debugger esté attachado; clear:true los quita todos.
const NET_PRESETS = {
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  "slow-3g": { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },
  "fast-3g": { offline: false, latency: 150, downloadThroughput: 180 * 1024, uploadThroughput: 94 * 1024 },
};

async function toolEmulate(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const applied = {};
  if (args.clear === true) {
    await cdp(tabId, "Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp(tabId, "Emulation.setEmulatedMedia", { features: [] });
    await cdp(tabId, "Emulation.setUserAgentOverride", { userAgent: "" });
    await cdp(tabId, "Emulation.clearGeolocationOverride", {});
    await cdp(tabId, "Emulation.setLocaleOverride", { locale: "" }).catch(() => {});
    await cdp(tabId, "Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    return { cleared: true };
  }
  if (args.network !== undefined) {
    const preset = NET_PRESETS[args.network];
    if (!preset)
      fail("invalid_argument", `network presets: ${Object.keys(NET_PRESETS).join(", ")}`, `emulate: unknown network ${args.network}`);
    await cdp(tabId, "Network.emulateNetworkConditions", preset);
    applied.network = args.network;
  }
  if (args.cpu !== undefined) {
    if (typeof args.cpu !== "number" || args.cpu < 1)
      fail("invalid_argument", "cpu is a throttling rate >= 1 (1 = none)", `emulate: bad cpu ${args.cpu}`);
    await cdp(tabId, "Emulation.setCPUThrottlingRate", { rate: args.cpu });
    applied.cpu = args.cpu;
  }
  if (args.geolocation !== undefined) {
    const g = args.geolocation;
    if (typeof g?.latitude !== "number" || typeof g?.longitude !== "number")
      fail("invalid_argument", "geolocation needs {latitude, longitude}", "emulate: bad geolocation");
    await cdp(tabId, "Emulation.setGeolocationOverride", {
      latitude: g.latitude,
      longitude: g.longitude,
      accuracy: typeof g.accuracy === "number" ? g.accuracy : 100,
    });
    applied.geolocation = { latitude: g.latitude, longitude: g.longitude, accuracy: g.accuracy ?? 100 };
  }
  const mediaFeatures = [];
  if (args.color_scheme !== undefined)
    mediaFeatures.push({ name: "prefers-color-scheme", value: args.color_scheme });
  if (args.reduced_motion !== undefined)
    mediaFeatures.push({ name: "prefers-reduced-motion", value: args.reduced_motion ? "reduce" : "no-preference" });
  if (mediaFeatures.length) {
    await cdp(tabId, "Emulation.setEmulatedMedia", { features: mediaFeatures });
    if (args.color_scheme !== undefined) applied.color_scheme = args.color_scheme;
    if (args.reduced_motion !== undefined) applied.reduced_motion = args.reduced_motion;
  }
  if (args.user_agent !== undefined) {
    await cdp(tabId, "Emulation.setUserAgentOverride", { userAgent: args.user_agent });
    applied.user_agent = true;
  }
  if (args.locale !== undefined) {
    await cdp(tabId, "Emulation.setLocaleOverride", { locale: args.locale });
    applied.locale = args.locale;
  }
  if (!Object.keys(applied).length)
    fail("invalid_argument", "pass at least one override or clear:true", "emulate: nothing to apply");
  return { applied };
}

// Emulation.setDeviceMetricsOverride persiste mientras el debugger esté attachado;
// clear:true lo quita (Emulation.clearDeviceMetricsOverride)
async function toolResizePage(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  if (args.clear === true) {
    await cdp(tabId, "Emulation.clearDeviceMetricsOverride", {});
    return { cleared: true };
  }
  requireArg(args, "width");
  requireArg(args, "height");
  await cdp(tabId, "Emulation.setDeviceMetricsOverride", {
    width: args.width,
    height: args.height,
    deviceScaleFactor: 0,
    mobile: false,
  });
  return { width: args.width, height: args.height };
}

// Los items de chrome.downloads no llevan tabId: el tab solo actúa de gate de
// sesión attached. Polling con search (sin listeners) sobrevive al restart del
// service worker y evita estado in-flight.
async function toolWaitDownload(args = {}) {
  await resolveTabId(args);
  const timeout = typeof args.timeout_ms === "number" ? args.timeout_ms : 30000;
  const deadline = Date.now() + timeout;
  // un download puede arrancar un instante antes de que la tool corra (click -> bridge -> SW)
  const grace = new Date(Date.now() - 3000).toISOString();
  let watchId = null;
  while (true) {
    if (watchId == null) {
      const recent = await chrome.downloads.search({
        startedAfter: grace, orderBy: ["-startTime"], limit: 20,
      });
      const cand = recent.find((d) => d.state === "in_progress")
        ?? recent.find((d) => d.state === "complete" || d.state === "interrupted");
      if (!cand) {
        if (Date.now() >= deadline) break;
        await sleep(200);
        continue;
      }
      watchId = cand.id;
    }
    const [item] = await chrome.downloads.search({ id: watchId });
    if (!item) break;
    if (item.state === "interrupted")
      fail(
        "download_interrupted",
        "check the browser's downloads page for the failure reason",
        `wait_download: descarga interrumpida (${item.error ?? "unknown"})`
      );
    if (item.state === "complete")
      return {
        id: item.id,
        path: item.filename,
        filename: item.filename.split(/[\\/]/).pop(),
        bytes: item.fileSize,
        mime: item.mime,
        url: item.finalUrl || item.url,
        exists: item.exists,
      };
    if (Date.now() >= deadline) break;
    await sleep(200);
  }
  fail(
    "wait_timeout",
    "no download started or finished before the timeout; verify the click actually triggers a download",
    `wait_download: sin descarga en ${timeout}ms`
  );
}

// Adapters validados bridge-side (~/.config/opencode-chrome/adapters/). El origen
// de la receta debe caer dentro del alcance de la attachment — misma frontera que
// SSO redirects y OOPIFs. El JS de `eval` lo escribió el usuario en su disco; el
// modelo solo pasa params, interpolados como literales JSON en steps eval
// (imposible romper el contexto del script con un valor).
function recipeInterp(template, params, jsonEncode) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!params || !(key in params))
      fail(
        "invalid_recipe",
        `declare "${key}" in the adapter's params and pass it to run_recipe`,
        `run_recipe: param no provisto: ${key}`
      );
    return jsonEncode ? JSON.stringify(String(params[key])) : String(params[key]);
  });
}

async function toolRunRecipe(args) {
  const recipe = args?.recipe;
  if (
    !recipe || typeof recipe.name !== "string" || typeof recipe.origin !== "string" ||
    !Array.isArray(recipe.steps) || !recipe.steps.length
  )
    fail("invalid_recipe", "fix the adapter JSON in ~/.config/opencode-chrome/adapters/", "run_recipe: receta malformada");
  const tabId = await resolveTabId(args);
  const { [ATTACHMENTS]: attachments = {} } = await chrome.storage.session.get(ATTACHMENTS);
  const attachedOrigin = attachments[String(tabId)]?.origin;
  if (!attachedOrigin || !originAllowed(attachedOrigin, `${recipe.origin}/`, originAllowlist))
    fail(
      "origin_not_allowed",
      "the recipe's origin is outside this attachment's reach; attach a tab on that origin or extend origin_allowlist in ~/.config/opencode-chrome/policy.json",
      `run_recipe: origen no permitido: ${recipe.origin}`
    );
  const params = args.params && typeof args.params === "object" ? args.params : {};
  // init_script: JS on-new-document registrado solo por la duración de la receta
  // (auth/session setup). File-sourced como eval, removido al terminar para que
  // no se acumulen ni sigan corriendo en navs ajenos a la receta.
  const scriptIds = [];
  try {
    let out = null;
    for (const step of recipe.steps) {
      if (typeof step.navigate === "string")
        out = await toolNavigate({ url: recipeInterp(step.navigate, params), tabId });
      else if (typeof step.wait_for === "string")
        out = await toolWaitFor({ text: recipeInterp(step.wait_for, params), timeout: step.timeout, tabId });
      else if (typeof step.init_script === "string") {
        await ensureAttached(tabId);
        const res = await cdp(tabId, "Page.addScriptToEvaluateOnNewDocument", {
          source: recipeInterp(step.init_script, params, true),
        });
        if (res?.identifier) scriptIds.push(res.identifier);
      } else if (typeof step.eval === "string")
        out = await evaluate(tabId, recipeInterp(step.eval, params, true));
      else if (Array.isArray(step.columns))
        out = {
          columns: step.columns,
          rows: (Array.isArray(out) ? out : []).map((row) =>
            Object.fromEntries(step.columns.map((c) => [c, row?.[c]]))
          ),
        };
      else fail("invalid_recipe", `unknown step: ${JSON.stringify(step)}`, "run_recipe: step desconocido");
    }
    return { name: recipe.name, output: out };
  } finally {
    for (const identifier of scriptIds)
      await cdp(tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => {});
  }
}

// Árbol de frames del tab: los OOPIFs (cross-origin, sesión hija del auto-attach)
// reportan su sessionId y si su origen está en la allowlist del origen attached.
// Sirve para descubrir qué pasarle a `frame` en snapshot/find/read_text.
async function toolListFrames(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const tree = await cdp(tabId, "Page.getFrameTree", {});
  const { [ATTACHMENTS]: attachments = {} } = await chrome.storage.session.get(ATTACHMENTS);
  const origin = attachments[String(tabId)]?.origin;
  const byTarget = new Map();
  for (const [sessionId, t] of frameStore(tabId)) byTarget.set(t.targetId, sessionId);
  const frames = [];
  const walk = (node, parentFrameId) => {
    const f = node.frame;
    const sessionId = byTarget.get(f.id);
    frames.push({
      frameId: f.id,
      url: f.url,
      parentFrameId,
      oopif: sessionId !== undefined,
      sessionId,
      allowed: sessionId === undefined ? true : !!origin && originAllowed(origin, f.url, originAllowlist),
    });
    for (const c of node.childFrames ?? []) walk(c, f.id);
  };
  walk(tree.frameTree, null);
  return { frames };
}

const TOOLS = {
  browser_status: toolBrowserStatus,
  list_tabs: toolListTabs,
  new_tab: toolNewTab,
  close_tab: (a) => handleCloseActivate("close_tab", a),
  activate_tab: (a) => handleCloseActivate("activate_tab", a),
  navigate: toolNavigate,
  snapshot: toolSnapshot,
  find: toolFind,
  read_text: toolReadText,
  list_frames: toolListFrames,
  click: toolClick,
  hover: toolHover,
  drag: toolDrag,
  type: toolType,
  fill: toolFill,
  select: toolSelect,
  form_schema: toolFormSchema,
  apply_mapping: toolApplyMapping,
  list_profile_keys: toolListProfileKeys,
  press_key: toolPressKey,
  scroll: toolScroll,
  upload: toolUpload,
  list_dialogs: toolListDialogs,
  handle_dialog: toolHandleDialog,
  list_network: toolListNetwork,
  list_storage_keys: toolListStorageKeys,
  list_console_messages: toolListConsoleMessages,
  get_network_body: toolGetNetworkBody,
  screenshot: toolScreenshot,
  resize_page: toolResizePage,
  emulate: toolEmulate,
  wait_for: toolWaitFor,
  wait_download: toolWaitDownload,
  run_recipe: toolRunRecipe,
};

async function handle(tool, args) {
  const fn = TOOLS[tool];
  if (!fn)
    fail("unknown_tool", "call the tools/list endpoint to see the available tool names", `unknown tool: ${tool}`);
  return fn(args);
}

setBadge(false);
connect();
