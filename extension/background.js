import { attachedTab, exactOrigin, mostRecentAttached, pollWhileAttached, serializeMutation } from "./policy.js";

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
const refStores = new Map(); // tabId -> { refs: { [ref]: selectorCSS } } del último snapshot
const netStores = new Map(); // tabId -> { order: [requestId], byId: Map } ring buffer de red
const dialogStores = new Map(); // tabId -> { recent: [], pending, policy } de diálogos JS
const debuggerSessions = new Map(); // tabId -> { attach: Promise, idle: timer }
const ATTACHMENTS = "attachments";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function refreshBadges() {
  const tabs = await chrome.tabs.query({});
  const { [ATTACHMENTS]: attachments = {} } = await chrome.storage.session.get(ATTACHMENTS);
  await Promise.all(
    tabs.map((tab) => {
      const attached = attachedTab(attachments, tab.id, tab.url);
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

async function connect() {
  if (ws && ws.readyState !== WebSocket.CLOSED) return;
  clearTimeout(reconnectTimer);
  const attempt = ++connectionAttempt;
  const { token } = await chrome.storage.local.get("token");
  if (attempt !== connectionAttempt) return;
  if (!token) return; // sin token configurado en las opciones no hay a quien autenticar
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(token)}`);
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
    watchConnection(CONNECTION_IDLE_MS);
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg.id !== "number" || typeof msg.tool !== "string") return;
    handle(msg.tool, msg.args || {})
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
  };
}

function reconnectNow() {
  ++connectionAttempt;
  clearTimeout(reconnectTimer);
  clearTimeout(connectionTimer);
  const previous = ws;
  ws = null;
  setBadge(false);
  if (previous) {
    try {
      previous.close();
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
    sendResponse({ connected: !!ws && ws.readyState === WebSocket.OPEN });
  }
});

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // CONNECTING cuenta como intento en curso; no duplicar conexiones
  if (!ws || ws.readyState === WebSocket.CLOSED) connect();
});

function send(socket, msg) {
  if (ws === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
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

async function resolveTabId(args) {
  const { [ATTACHMENTS]: attachments = {} } = await chrome.storage.session.get(ATTACHMENTS);
  if (args.tabId !== undefined) {
    if (typeof args.tabId !== "number")
      fail("invalid_argument", "pass a numeric tabId from list_tabs", "tabId must be a number");
    const tab = await chrome.tabs.get(args.tabId).catch(() => null);
    if (!tab || !attachedTab(attachments, tab.id, tab.url))
      fail(
        "tab_not_attached",
        "attach the tab via the extension icon; if it navigated to a different origin, attach it again there",
        "tab is not attached or origin changed"
      );
    return tab.id;
  }
  const tabs = await chrome.tabs.query({});
  const recent = mostRecentAttached(attachments, tabs);
  if (!recent)
    fail("no_attached_tab", "focus a tab and click the extension icon to attach it, then retry", "no attached tab");
  return recent.tab.id;
}

async function assertAttached(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const { [ATTACHMENTS]: attachments = {} } = await chrome.storage.session.get(ATTACHMENTS);
  if (!tab || !attachedTab(attachments, tabId, tab.url))
    fail(
      "origin_changed",
      "the tab navigated to a different origin or was detached; re-attach it via the extension icon and retry",
      "tab is no longer attached or origin changed"
    );
  return tab;
}

async function toggleAttachment() {
  return serializeMutation(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) fail("no_active_tab", "focus a tab and retry", "no active tab");
    const { [ATTACHMENTS]: attachments = {} } = await chrome.storage.session.get(ATTACHMENTS);
    const key = String(tab.id);
    if (attachedTab(attachments, tab.id, tab.url)) delete attachments[key];
    else {
      const origin = exactOrigin(tab.url);
      if (!origin)
        fail("unsupported_scheme", "only http/https tabs can be attached", "only http(s) tabs can be attached");
      attachments[key] = { origin, attachedAt: Date.now() };
    }
    await chrome.storage.session.set({ [ATTACHMENTS]: attachments });
    await refreshBadges();
  });
}

chrome.action.onClicked.addListener(() => toggleAttachment().catch(() => {}));

// --- chrome.debugger / CDP ---

async function cdp(tabId, method, params) {
  await assertAttached(tabId);
  const result = await new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
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
}

const NET_RING_LIMIT = 100;
const DIALOG_RING_LIMIT = 20;

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

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!debuggerSessions.has(tabId)) return; // solo tabs con debugger nuestro
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
      ts: params.timestamp,
    });
    while (s.order.length > NET_RING_LIMIT) s.byId.delete(s.order.shift());
  } else if (method === "Network.responseReceived") {
    const e = s.byId.get(params.requestId);
    if (e) {
      e.status = params.response.status;
      e.mimeType = params.response.mimeType;
    }
  } else if (method === "Network.loadingFinished") {
    const e = s.byId.get(params.requestId);
    if (e) e.size = params.encodedDataLength;
  }
});

function detachDebugger(tabId) {
  const session = debuggerSessions.get(tabId);
  if (!session) return;
  clearTimeout(session.idle);
  debuggerSessions.delete(tabId);
  chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
}

chrome.debugger.onDetach.addListener((source) => {
  const session = debuggerSessions.get(source.tabId);
  if (session) {
    clearTimeout(session.idle);
    debuggerSessions.delete(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  refStores.delete(tabId);
  netStores.delete(tabId);
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
    dialogStores.delete(tabId);
  }
  if (!info.url) return;
  serializeMutation(async () => {
    const { [ATTACHMENTS]: attachments = {} } = await chrome.storage.session.get(ATTACHMENTS);
    const entry = attachments[String(tabId)];
    if (entry && entry.origin !== exactOrigin(info.url)) {
      delete attachments[String(tabId)];
      await chrome.storage.session.set({ [ATTACHMENTS]: attachments });
      await refreshBadges();
    }
  }).catch(() => {});
});

async function evaluate(tabId, expression) {
  const res = await cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
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

function SNAPSHOT_SCRIPT() {
  const MAX_LINES = 300;
  const MAX_CHARS = 20000;
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

  // texto propio = solo nodos de texto directos, evita duplicar li>p
  const ownText = (el) => {
    let s = "";
    for (const c of el.childNodes) if (c.nodeType === 3) s += c.textContent;
    return s.replace(/\s+/g, " ").trim();
  };

  const nameOf = (el) => {
    let name = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
    if (!name) {
      if (el.labels && el.labels[0]) name = el.labels[0].innerText;
      else if (el.type === "submit" || el.type === "button") name = el.value || "";
      else name = el.innerText || el.value || el.placeholder || "";
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

  const describe = (el) => {
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
    const parts = [role];
    const name = nameOf(el);
    if (name) parts.push(JSON.stringify(name));
    if (tag === "a" && el.getAttribute("href") != null) parts.push("href=" + JSON.stringify(el.getAttribute("href")));
    if ((tag === "input" || tag === "textarea") && el.value) parts.push("value=" + JSON.stringify(String(el.value).slice(0, 80)));
    return parts.join(" ");
  };

  for (const el of document.querySelectorAll("*")) {
    const isInteractive = el.matches(INTERACTIVE);
    if (overLimit && !isInteractive) continue; // pasada de recorte: solo interactivos
    if (!visible(el)) continue;
    let line;
    if (isInteractive) {
      refCount += 1;
      line = "[ref=" + refCount + "] " + describe(el);
      // fp = identidad del elemento al momento del snapshot; se verifica antes de actuar
      refs[refCount] = { sel: selectorFor(el), fp: el.tagName.toLowerCase() + "|" + nameOf(el) };
    } else {
      if (!el.matches(TEXTY)) continue;
      const txt = ownText(el);
      if (!txt) continue;
      line = el.tagName.toLowerCase() + " " + JSON.stringify(txt.slice(0, 100));
    }
    let depth = 0;
    for (let n = el; n.parentElement; n = n.parentElement) depth++;
    lines.push("  ".repeat(Math.min(depth, 12)) + line);
    chars += line.length + 1;
    if (lines.length >= MAX_LINES || chars >= MAX_CHARS) overLimit = true;
    if (lines.length >= MAX_LINES * 2) break;
  }
  if (overLimit) lines.push("… truncated: text content omitted, take a focused snapshot if needed");
  return { snapshot: lines.join("\n"), refs };
}

// Verificacion pre-accion del fp de un ref. nameOf debe calcularse igual que en SNAPSHOT_SCRIPT.
function REF_CHECK_SCRIPT(sel, fp) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { found: false };
    let name = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
    if (!name) {
      if (el.labels && el.labels[0]) name = el.labels[0].innerText;
      else if (el.type === "submit" || el.type === "button") name = el.value || "";
      else name = el.innerText || el.value || el.placeholder || "";
    }
    name = name.replace(/\\s+/g, " ").trim().slice(0, 80);
    return { found: true, match: (el.tagName.toLowerCase() + "|" + name) === ${JSON.stringify(fp)} };
  })()`;
}

// --- tools ---

async function toolListTabs() {
  const tabs = await chrome.tabs.query({});
  const { [ATTACHMENTS]: attachments = {} } = await chrome.storage.session.get(ATTACHMENTS);
  return { tabs: tabs.filter((t) => attachedTab(attachments, t.id, t.url)).map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })) };
}

async function toolBrowserStatus() {
  const { [ATTACHMENTS]: attachments = {} } = await chrome.storage.session.get(ATTACHMENTS);
  const tabs = await chrome.tabs.query({});
  return { connected: !!ws && ws.readyState === WebSocket.OPEN, attached: tabs.filter((t) => attachedTab(attachments, t.id, t.url)).map((t) => ({ tabId: t.id, origin: attachments[String(t.id)].origin, attachedAt: attachments[String(t.id)].attachedAt })) };
}

async function toolNewTab(args) {
  const tab = await chrome.tabs.create({ url: args.url || "about:blank", active: true });
  return { id: tab.id };
}

async function handleCloseActivate(tool, args) {
  requireArg(args, "id");
  if (typeof args.id !== "number")
    fail("invalid_argument", "pass a numeric id from list_tabs", "id must be a number");
  const tabId = await resolveTabId({ tabId: args.id });
  if (tool === "close_tab") await chrome.tabs.remove(tabId);
  else await chrome.tabs.update(tabId, { active: true });
  return {};
}

async function toolNavigate(args) {
  requireArg(args, "url");
  const tabId = await resolveTabId(args);
  await assertAttached(tabId);
  await chrome.tabs.update(tabId, { url: args.url });
  await sleep(200); // margen para que status pase a loading antes del primer chequeo
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      fail("tab_closed", "the tab is gone; open a new one with new_tab or use another tabId from list_tabs", "tab was closed during navigation");
    }
    if (tab.status === "complete") return { url: tab.url };
    await sleep(250);
  }
  fail(
    "navigation_timeout",
    "the page may still be loading; retry, or poll for content with wait_for",
    "navigate: timed out waiting for load (30s)"
  );
}

async function resolveRef(tabId, ref) {
  const store = refStores.get(tabId);
  const entry = store && store.refs[ref];
  if (!entry)
    fail("stale_ref", "take a fresh snapshot and use a ref from it", "ref not found, take a new snapshot");
  await ensureAttached(tabId);
  const state = await evaluate(tabId, REF_CHECK_SCRIPT(entry.sel, entry.fp));
  if (!state.found)
    fail("stale_ref", "take a fresh snapshot and use a ref from it", "element for this ref is gone, take a new snapshot");
  if (!state.match)
    fail("stale_ref", "take a fresh snapshot and use a ref from it", "element changed since the snapshot, take a new one");
  return entry.sel;
}

async function toolSnapshot(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const out = await evaluate(tabId, `(${SNAPSHOT_SCRIPT})()`);
  refStores.set(tabId, { refs: out.refs });
  return { snapshot: out.snapshot };
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
  const res = await cdp(tabId, "Runtime.evaluate", {
    expression: `(${scroll}).then(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.innerText.slice(0, ${max}) : null; })`,
    returnByValue: true,
    awaitPromise: true,
  });
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

async function elementCenter(tabId, sel) {
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
    })()`
  );
}

async function toolClick(args) {
  requireArg(args, "ref");
  const tabId = await resolveTabId(args);
  const sel = await resolveRef(tabId, args.ref);
  const point = await elementCenter(tabId, sel);
  if (!point)
    fail("element_not_found", "the element moved or vanished; take a new snapshot and retry", `click: element not found or not visible: ${sel}`);
  const at = { x: point.x, y: point.y, button: "left", clickCount: 1 };
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...at, clickCount: 0 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...at });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
  return { clicked: true, x: point.x, y: point.y, obscured: point.obscured };
}

async function toolHover(args) {
  requireArg(args, "ref");
  const tabId = await resolveTabId(args);
  const sel = await resolveRef(tabId, args.ref);
  const point = await elementCenter(tabId, sel);
  if (!point)
    fail("element_not_found", "the element moved or vanished; take a new snapshot and retry", `hover: element not found or not visible: ${sel}`);
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  return { hovered: true, x: point.x, y: point.y, obscured: point.obscured };
}

async function toolDrag(args) {
  requireArg(args, "from");
  requireArg(args, "to");
  const tabId = await resolveTabId(args);
  const from = await elementCenter(tabId, await resolveRef(tabId, args.from));
  if (!from)
    fail("element_not_found", "the source element moved or vanished; take a new snapshot and retry", `drag: source ref not found or not visible`);
  const to = await elementCenter(tabId, await resolveRef(tabId, args.to));
  if (!to)
    fail("element_not_found", "the target element moved or vanished; take a new snapshot and retry", `drag: target ref not found or not visible`);
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= 3; i++) {
    const x = from.x + ((to.x - from.x) * i) / 3;
    const y = from.y + ((to.y - from.y) * i) / 3;
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left" });
  }
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
  return { dragged: true, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } };
}

// estrategia type: focus via evaluate + Input.insertText (respeta eventos/input method), Enter como keyDown text="\r" + keyUp
async function toolType(args) {
  requireArg(args, "ref");
  requireArg(args, "text");
  const tabId = await resolveTabId(args);
  const sel = await resolveRef(tabId, args.ref);
  await evaluate(
    tabId,
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({block:"center"}); el.focus(); return true; })()`
  );
  const body = args.text.endsWith("\n") ? args.text.slice(0, -1) : args.text;
  if (body) await cdp(tabId, "Input.insertText", { text: body });
  if (args.text.endsWith("\n")) {
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...enter });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...enter });
  }
  return {};
}

// fill: setter nativo del prototipo + input/change con bubbles (React/Vue
// controlled inputs no se revierten), contenteditable via textContent, y
// read-back para detectar campos que comen caracteres en silencio
async function toolFill(args) {
  requireArg(args, "ref");
  requireArg(args, "value");
  const tabId = await resolveTabId(args);
  const sel = await resolveRef(tabId, args.ref);
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
    })()`
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
  return out;
}

// select: match por label antes que por value; el error lista las opciones
// disponibles (cap 50) para que el agente reintente sin otro snapshot
async function toolSelect(args) {
  requireArg(args, "ref");
  requireArg(args, "option");
  const tabId = await resolveTabId(args);
  const sel = await resolveRef(tabId, args.ref);
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
    })()`
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
  return out;
}

async function toolScroll(args) {
  const tabId = await resolveTabId(args);
  if (args.ref !== undefined) {
    const sel = await resolveRef(tabId, args.ref);
    const ok = await evaluate(
      tabId,
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({block:"center"}); return true; })()`
    );
    if (!ok)
      fail("element_not_found", "the element moved or vanished; take a new snapshot and retry", `scroll: element not found: ${sel}`);
    return { scrolled: true };
  }
  const dx = args.dx ?? 0;
  const dy = args.dy ?? 600;
  const pos = await evaluate(
    tabId,
    `(() => { scrollBy(${JSON.stringify(dx)}, ${JSON.stringify(dy)}); return { x: scrollX, y: scrollY, maxY: document.documentElement.scrollHeight - innerHeight }; })()`
  );
  return { scrolled: true, x: pos.x, y: pos.y, at_bottom: pos.y >= pos.maxY };
}

// upload: DOM.setFileInputFiles pone los paths directo en el input; Chrome
// (el proceso browser) lee los archivos, la extensión nunca toca el contenido
async function toolUpload(args) {
  requireArg(args, "ref");
  requireArg(args, "files");
  const tabId = await resolveTabId(args);
  const sel = await resolveRef(tabId, args.ref);
  const kind = await evaluate(
    tabId,
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.tagName + ":" + (el.getAttribute("type") || "") : null; })()`
  );
  if (!kind)
    fail("element_not_found", "the element moved or vanished; take a new snapshot and retry", `upload: element not found: ${sel}`);
  if (!/^INPUT:file$/i.test(kind))
    fail("wrong_element_type", "the ref must point to an <input type=file>", `upload: ref is not a file input (${kind})`);
  const doc = await cdp(tabId, "DOM.getDocument", {});
  const node = await cdp(tabId, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel });
  if (!node.nodeId)
    fail("element_not_found", "take a new snapshot and retry", `upload: node not found via DOM domain: ${sel}`);
  await cdp(tabId, "DOM.setFileInputFiles", { nodeId: node.nodeId, files: args.files });
  return { uploaded: args.files.length, files: args.files };
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

async function toolListNetwork(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const s = netStores.get(tabId);
  let rows = s ? s.order.map((id) => s.byId.get(id)).filter(Boolean) : [];
  if (args.filter) rows = rows.filter((r) => r.url.includes(args.filter));
  return { requests: rows };
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

async function toolScreenshot(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const res = await cdp(tabId, "Page.captureScreenshot", { format: "png" });
  return { image: res.data };
}

async function toolWaitFor(args) {
  requireArg(args, "text");
  const timeout = typeof args.timeout === "number" ? args.timeout : 10000;
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const expr = `(() => { try { return document.body && document.body.innerText.includes(${JSON.stringify(args.text)}); } catch { return false; } })()`;
  const found = await pollWhileAttached({
    assertAttached: () => assertAttached(tabId),
    check: () => evaluate(tabId, expr),
    pause: sleep,
    timeout,
  });
  if (!found)
    fail(
      "wait_timeout",
      "increase timeout, or check the text appears exactly as rendered in the page",
      `wait_for: "${args.text}" no apareció en ${timeout}ms`
    );
  return { found: true };
}

const TOOLS = {
  browser_status: toolBrowserStatus,
  list_tabs: toolListTabs,
  new_tab: toolNewTab,
  close_tab: (a) => handleCloseActivate("close_tab", a),
  activate_tab: (a) => handleCloseActivate("activate_tab", a),
  navigate: toolNavigate,
  snapshot: toolSnapshot,
  read_text: toolReadText,
  click: toolClick,
  hover: toolHover,
  drag: toolDrag,
  type: toolType,
  fill: toolFill,
  select: toolSelect,
  scroll: toolScroll,
  upload: toolUpload,
  list_dialogs: toolListDialogs,
  handle_dialog: toolHandleDialog,
  list_network: toolListNetwork,
  get_network_body: toolGetNetworkBody,
  screenshot: toolScreenshot,
  wait_for: toolWaitFor,
};

async function handle(tool, args) {
  const fn = TOOLS[tool];
  if (!fn)
    fail("unknown_tool", "call the tools/list endpoint to see the available tool names", `unknown tool: ${tool}`);
  return fn(args);
}

setBadge(false);
connect();
