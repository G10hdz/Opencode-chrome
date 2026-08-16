// opencode-chrome service worker: cliente WS del puente MCP + control CDP via chrome.debugger.

const PORT = 9223; // el puente lee OPENCODE_CHROME_PORT de su lado; este default debe coincidir
const RECONNECT_MS = 3000;
const DEBUGGER_IDLE_MS = 30000; // auto-detach para que el banner "being debugged" desaparezca solo

let ws = null;
const refStores = new Map(); // tabId -> { refs: { [ref]: selectorCSS } } del último snapshot
const debuggerSessions = new Map(); // tabId -> { attach: Promise, idle: timer }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? "on" : "off" });
  chrome.action.setBadgeBackgroundColor({ color: on ? "#2e7d32" : "#757575" });
}

function connect() {
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.onopen = () => setBadge(true);
  ws.onclose = () => {
    setBadge(false);
    setTimeout(connect, RECONNECT_MS);
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg.id !== "number" || typeof msg.tool !== "string") return;
    handle(msg.tool, msg.args || {})
      .then((result) => send({ id: msg.id, result }))
      .catch((e) => send({ id: msg.id, error: { message: e?.message || String(e) } }));
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

const requireArg = (args, name) => {
  if (args[name] === undefined || args[name] === null) throw new Error(`falta el argumento ${name}`);
};

async function resolveTabId(args) {
  if (args.tabId !== undefined) {
    if (typeof args.tabId !== "number") throw new Error("tabId debe ser un número");
    return args.tabId;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("no hay pestaña activa");
  return tab.id;
}

// --- chrome.debugger / CDP ---

function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`CDP ${method}: ${err.message}`));
      else resolve(res);
    });
  });
}

async function ensureAttached(tabId) {
  let session = debuggerSessions.get(tabId);
  if (!session) {
    session = {};
    session.attach = new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(`debugger attach: ${err.message}`));
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
}

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
  detachDebugger(tabId);
});

// navegación invalida los refs: obliga a re-snapshot en vez de clickear selectores viejos
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status === "loading") refStores.delete(tabId);
});

async function evaluate(tabId, expression) {
  const res = await cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(`page script: ${d.exception?.description || d.text}`);
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
      refs[refCount] = selectorFor(el);
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
  if (overLimit) lines.push("… (recortado: contenido de texto omitido, snapshot enfocado si hace falta)");
  return { snapshot: lines.join("\n"), refs };
}

// --- tools ---

async function toolListTabs() {
  const tabs = await chrome.tabs.query({});
  return { tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })) };
}

async function toolNewTab(args) {
  const tab = await chrome.tabs.create({ url: args.url || "about:blank", active: true });
  return { id: tab.id };
}

async function handleCloseActivate(tool, args) {
  requireArg(args, "id");
  if (typeof args.id !== "number") throw new Error("id debe ser un número");
  if (tool === "close_tab") await chrome.tabs.remove(args.id);
  else await chrome.tabs.update(args.id, { active: true });
  return {};
}

async function toolNavigate(args) {
  requireArg(args, "url");
  const tabId = await resolveTabId(args);
  await chrome.tabs.update(tabId, { url: args.url });
  await sleep(200); // margen para que status pase a loading antes del primer chequeo
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error("la pestaña se cerró durante la navegación");
    }
    if (tab.status === "complete") return { url: tab.url };
    await sleep(250);
  }
  throw new Error("navigate: timeout esperando carga (30s)");
}

function lookupRef(tabId, ref) {
  const sel = refStores.get(tabId)?.refs[ref];
  if (!sel) throw new Error("ref no encontrado, tomá un snapshot nuevo");
  return sel;
}

async function toolSnapshot(args) {
  const tabId = await resolveTabId(args);
  await ensureAttached(tabId);
  const out = await evaluate(tabId, `(${SNAPSHOT_SCRIPT})()`);
  refStores.set(tabId, { refs: out.refs });
  return { snapshot: out.snapshot };
}

async function toolClick(args) {
  requireArg(args, "ref");
  const tabId = await resolveTabId(args);
  const sel = lookupRef(tabId, args.ref);
  await ensureAttached(tabId);
  const hit = await evaluate(
    tabId,
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({block:"center"}); el.click(); return true; })()`
  );
  if (!hit) throw new Error("ref no encontrado, tomá un snapshot nuevo");
  return {};
}

// estrategia type: focus via evaluate + Input.insertText (respeta eventos/input method), Enter como keyDown text="\r" + keyUp
async function toolType(args) {
  requireArg(args, "ref");
  requireArg(args, "text");
  const tabId = await resolveTabId(args);
  const sel = lookupRef(tabId, args.ref);
  await ensureAttached(tabId);
  const focused = await evaluate(
    tabId,
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({block:"center"}); el.focus(); return true; })()`
  );
  if (!focused) throw new Error("ref no encontrado, tomá un snapshot nuevo");
  const body = args.text.endsWith("\n") ? args.text.slice(0, -1) : args.text;
  if (body) await cdp(tabId, "Input.insertText", { text: body });
  if (args.text.endsWith("\n")) {
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...enter });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...enter });
  }
  return {};
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
  const deadline = Date.now() + timeout;
  while (true) {
    if (await evaluate(tabId, expr)) return { found: true };
    if (Date.now() >= deadline) throw new Error(`wait_for: "${args.text}" no apareció en ${timeout}ms`);
    await sleep(500);
  }
}

const TOOLS = {
  list_tabs: toolListTabs,
  new_tab: toolNewTab,
  close_tab: (a) => handleCloseActivate("close_tab", a),
  activate_tab: (a) => handleCloseActivate("activate_tab", a),
  navigate: toolNavigate,
  snapshot: toolSnapshot,
  click: toolClick,
  type: toolType,
  screenshot: toolScreenshot,
  wait_for: toolWaitFor,
};

async function handle(tool, args) {
  const fn = TOOLS[tool];
  if (!fn) throw new Error(`tool desconocida: ${tool}`);
  return fn(args);
}

setBadge(false);
connect();
