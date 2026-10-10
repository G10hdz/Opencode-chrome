#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket, { WebSocketServer } from "ws";
import { registerTools, outputToFile } from "./tools.js";
import { parseSessionConfig, sessionPorts, DEFAULT_PORT, clampPort } from "./sessions.js";
import { spawnSync } from "node:child_process";

// default 19223 — 9223 is often taken by Electron --remote-debugging-port (OpenWork, etc.)
// bridgePort es el puerto de ESTE proceso. Con el tope en 1 es el de siempre.
let bridgePort = DEFAULT_PORT;
const TIMEOUT_MS = parseInt(process.env.OPENCODE_CHROME_TIMEOUT_MS, 10) || 30000;
// <30s: cada mensaje recibido resetea el idle timer del service worker (Chrome 116+)
const KEEPALIVE_MS = parseInt(process.env.OPENCODE_CHROME_KEEPALIVE_MS, 10) || 20000;

// Token compartido con la extension: env var, o archivo persistente en ~/.config.
// Cualquier proceso local podria conectar al WS; sin token tendria control total de Chrome.
function loadToken() {
  if (process.env.OPENCODE_CHROME_TOKEN) return process.env.OPENCODE_CHROME_TOKEN;
  const file = join(homedir(), ".config", "opencode-chrome", "token");
  try {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) return saved;
  } catch {}
  const token = randomUUID().replaceAll("-", "");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}

// best-effort: copia el token al portapapeles para no tener que buscarlo en stderr
function copyToClipboard(text) {
  const cmds =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
  for (const [cmd, args] of cmds) {
    const r = spawnSync(cmd, args, { input: text });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

// Origin allowlist opcional: ~/.config/opencode-chrome/policy.json
// {"origin_allowlist": {"https://app.example.com": ["https://sso.example.com"]}}
// Se empuja a la extensión al conectar — la policy vive aquí, no en la página.
// Vacía = solo origen exacto (el default no se debilita).
function validOrigin(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

function loadPolicy() {
  const file =
    process.env.OPENCODE_CHROME_POLICY ||
    join(homedir(), ".config", "opencode-chrome", "policy.json");
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { origin_allowlist: {} };
  }
  const allow = {};
  const src = raw?.origin_allowlist;
  if (src && typeof src === "object") {
    for (const [from, to] of Object.entries(src)) {
      const fo = validOrigin(from);
      if (!fo || !Array.isArray(to)) continue;
      const list = to.map(validOrigin).filter(Boolean);
      if (list.length) allow[fo] = [...new Set(list)];
    }
  }
  return { origin_allowlist: allow };
}

function sessionFile() {
  return (
    process.env.OPENCODE_CHROME_CONFIG ||
    join(homedir(), ".config", "opencode-chrome", "config.json")
  );
}

function loadSessionConfig() {
  try {
    return parseSessionConfig(JSON.parse(readFileSync(sessionFile(), "utf8")));
  } catch {
    return parseSessionConfig(null);
  }
}

// Lo escribe el puente cuando la extensión avisa lo que la persona guardó.
// Un peer no pasa por aquí: no puede subir el tope.
function saveSessionConfig(input) {
  const next = parseSessionConfig(input);
  const file = sessionFile();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ sessions: next.sessions, port: next.port }) + "\n", {
    mode: 0o600,
  });
  return next;
}

function explicitPort() {
  return clampPort(process.env.OPENCODE_CHROME_PORT);
}

function sessionName() {
  const raw = process.env.OPENCODE_CHROME_SESSION;
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
}

const POLICY = loadPolicy();
if (Object.keys(POLICY.origin_allowlist).length)
  console.error(`opencode-chrome: origin allowlist for ${Object.keys(POLICY.origin_allowlist).length} origin(s)`);

// Site adapters (PARITY_SPEC 16): JSON en ~/.config/opencode-chrome/adapters/.
// El modelo elige qué receta correr; el JS de `eval` vive solo en archivos del
// usuario — nunca llega al modelo como herramienta de eval libre.
const ADAPTERS_DIR =
  process.env.OPENCODE_CHROME_ADAPTERS ||
  join(homedir(), ".config", "opencode-chrome", "adapters");

function loadRecipe(name) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(name)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(ADAPTERS_DIR, `${name}.json`), "utf8"));
  } catch {
    return null;
  }
  const origin = raw && typeof raw.origin === "string" ? validOrigin(raw.origin) : null;
  if (
    !origin || typeof raw.name !== "string" ||
    !Array.isArray(raw.steps) || raw.steps.length === 0
  )
    return null;
  raw.origin = origin;
  return raw;
}

function listRecipes() {
  let files;
  try {
    files = readdirSync(ADAPTERS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => loadRecipe(f.slice(0, -5)))
    .filter(Boolean)
    .map((r) => ({
      name: r.name,
      origin: r.origin,
      description: r.description ?? null,
      params: Array.isArray(r.params) ? r.params : [],
    }));
}

const TOKEN = loadToken();
const copied = process.env.OPENCODE_CHROME_TOKEN ? false : copyToClipboard(TOKEN);
console.error(
  `opencode-chrome: extension token ${TOKEN}` +
    (copied ? " (copied to your clipboard)" : "") +
    " — paste it into the extension options page"
);

let socket = null;
let nextId = 1;
const pending = new Map();
// otros procesos MCP (otro agente) que comparten este puente
const peers = new Set();
let peerMode = false;
let peerSocket = null;
const peerPending = new Map();
let stdioClosed = false;
let listenerReady = false;

// Errors carried over the wire/MCP keep a machine-readable code + an actionable remedy.
function toolError(errorCode, remedy, message) {
  const e = new Error(message);
  e.errorCode = errorCode;
  e.remedy = remedy;
  return e;
}

function notConnected() {
  return toolError(
    "extension_disconnected",
    "start Chrome with the extension loaded and paste the bridge token into its options page, then retry",
    `Chrome extension not connected on ws://127.0.0.1:${bridgePort}. ` +
      `Check Chrome is running and that the token in the extension options matches ` +
      `this bridge's token (printed to stderr at startup), then retry.`
  );
}

function callExtension(tool, args) {
  if (!socket || socket.readyState !== socket.OPEN) {
    return Promise.reject(notConnected());
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        toolError(
          "extension_timeout",
          "retry the call; if it keeps timing out the extension service worker may be stuck, reload it on chrome://extensions",
          `Extension did not respond to "${tool}" within ${TIMEOUT_MS}ms.`
        )
      );
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, tool, args }));
  });
}

function rejectPending(message) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(
      toolError("extension_disconnected", "retry once the extension reconnects", message)
    );
    pending.delete(id);
  }
}

function mcpFailure(err) {
  const error = {
    message: err.message,
    error_code: err.errorCode ?? "internal_error",
    remedy: err.remedy ?? "retry the call; if it persists, report this message",
  };
  return { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true };
}

// Un solo proceso escucha. El que llega después no abre otro puerto: manda
// las tool calls al que ya tiene la extensión. role=peer no manda Origin;
// un navegador siempre lo manda, y eso se rechaza para que una página no
// dispare tools aunque adivine el token.
function attachPeer(ws) {
  peers.add(ws);
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.id !== "number" || typeof msg.tool !== "string") return;
    const args = msg.args && typeof msg.args === "object" ? msg.args : {};
    handleTool(msg.tool, args).then((result) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });
  ws.on("close", () => {
    peers.delete(ws);
    if (stdioClosed && peers.size === 0) releaseListener();
  });
  ws.on("error", () => ws.terminate());
}

function startPeerMode() {
  peerMode = true;
  const url = `ws://127.0.0.1:${bridgePort}/?token=${encodeURIComponent(TOKEN)}&role=peer`;
  peerSocket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    peerSocket.once("open", () => {
      // un puente viejo nos toma por la extensión y empuja {policy} al toque
      setTimeout(() => finish(), 200);
    });
    peerSocket.once("error", (err) => {
      console.error(
        `opencode-chrome: cannot attach to the bridge on 127.0.0.1:${bridgePort} (${err.message ?? err})`
      );
      finish(err);
    });
    peerSocket.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!settled && msg && Object.prototype.hasOwnProperty.call(msg, "policy")) {
        console.error(
          `opencode-chrome: the bridge on 127.0.0.1:${bridgePort} is an older process and cannot take another client. Restart it and retry.`
        );
        try {
          peerSocket.close();
        } catch {}
        finish(new Error("old bridge"));
        return;
      }
      const entry = peerPending.get(msg?.id);
      if (!entry) return;
      peerPending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const err = new Error(msg.error.message ?? JSON.stringify(msg.error));
        if (msg.error.error_code) err.errorCode = msg.error.error_code;
        if (msg.error.remedy) err.remedy = msg.error.remedy;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
    });
    peerSocket.on("close", () => {
      for (const [id, entry] of peerPending) {
        clearTimeout(entry.timer);
        entry.reject(
          toolError(
            "extension_disconnected",
            "retry once the bridge is back",
            "the bridge closed the attached client"
          )
        );
        peerPending.delete(id);
      }
    });
  });
}

function callPeer(tool, args) {
  return new Promise((resolve, reject) => {
    const deliver = () => {
      if (!peerSocket || peerSocket.readyState !== WebSocket.OPEN) {
        reject(
          toolError(
            "bridge_busy",
            "restart the bridge that holds the port, then retry",
            `cannot attach to the bridge on 127.0.0.1:${bridgePort}`
          )
        );
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        peerPending.delete(id);
        reject(
          toolError(
            "extension_timeout",
            "retry the call; if it keeps timing out the extension service worker may be stuck, reload it on chrome://extensions",
            `attached bridge did not respond to "${tool}" within ${TIMEOUT_MS}ms`
          )
        );
      }, TIMEOUT_MS);
      peerPending.set(id, { resolve, reject, timer });
      peerSocket.send(JSON.stringify({ id, tool, args: args ?? {} }));
    };
    if (peerSocket?.readyState === WebSocket.OPEN) deliver();
    else if (peerSocket) peerSocket.once("open", deliver);
    else
      reject(
        toolError(
          "bridge_busy",
          "restart the bridge that holds the port, then retry",
          `cannot attach to the bridge on 127.0.0.1:${bridgePort}`
        )
      );
  }).then(
    (result) => result,
    (err) => mcpFailure(err)
  );
}

let wss = null;

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port });
    const onError = (err) => {
      server.on("error", () => {});
      server.close();
      reject(err);
    };
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

// Tope 1: si el puerto está ocupado, este proceso entra como peer.
// Tope mayor: toma el siguiente puerto libre del rango y no se engancha.
async function bindListener() {
  const cfg = loadSessionConfig();
  const pinned = explicitPort();
  const base = pinned || cfg.port;
  const ports = pinned || cfg.sessions === 1 ? [base] : sessionPorts(cfg.port, cfg.sessions);
  for (const port of ports) {
    try {
      const server = await listenOnce(port);
      wss = server;
      bridgePort = port;
      listenerReady = true;
      server.on("error", (err) => {
        console.error(`opencode-chrome: ${err.code ?? err.message}`);
      });
      serve(server);
      const label = sessionName();
      console.error(
        `opencode-chrome: listening on 127.0.0.1:${port}${label ? ` (${label})` : ""}`
      );
      return;
    } catch (err) {
      if (err.code !== "EADDRINUSE") {
        console.error(
          `opencode-chrome: cannot listen on 127.0.0.1:${port} (${err.code ?? err.message})`
        );
        process.exit(1);
      }
    }
  }
  if (cfg.sessions === 1) {
    bridgePort = base;
    console.error(
      `opencode-chrome: 127.0.0.1:${base} already has a bridge, attaching as another client`
    );
    await startPeerMode();
    return;
  }
  const hi = ports[ports.length - 1];
  console.error(
    `opencode-chrome: no free port in 127.0.0.1:${ports[0]}-${hi}. The session cap is ${cfg.sessions}. Close one, or raise it under Sesiones in the extension options.`
  );
  process.exit(1);
}

const bound = bindListener();

function serve(server) {
  server.on("connection", (ws, req) => {
  const origin = req.headers.origin;
  let url;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    ws.close(1008, "bad url");
    return;
  }
  const token = url.searchParams.get("token");
  if (token !== TOKEN) {
    ws.close(1008, "invalid token");
    return;
  }
  if (url.searchParams.get("role") === "peer") {
    if (origin) {
      ws.close(1008, "origin not allowed");
      return;
    }
    attachPeer(ws);
    return;
  }
  if (origin && !origin.startsWith("chrome-extension://")) {
    ws.close(1008, "origin not allowed");
    return;
  }
  if (socket) {
    rejectPending("Chrome extension connection replaced mid-call; check the page before retrying.");
    socket.terminate();
  }
  socket = ws;
  // la policy se empuja en cada conexión: una reconexión con otro bridge resetea la allowlist
  const name = sessionName();
  ws.send(
    JSON.stringify({
      policy: POLICY,
      session: { port: bridgePort, name: name || String(bridgePort) },
    })
  );
  // keepalive: no-op sin tool; la extension lo filtra y el SW recibe actividad que evita su suspension
  const keepalive = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id: -1 }));
  }, KEEPALIVE_MS);
  ws.on("message", (data) => {
    if (socket !== ws) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg && msg.configure && typeof msg.configure === "object" && msg.id === undefined) {
      const saved = saveSessionConfig(msg.configure);
      console.error(`opencode-chrome: sessions ${saved.sessions} from port ${saved.port}`);
      return;
    }
    const entry = pending.get(msg?.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      const err = new Error(msg.error.message ?? JSON.stringify(msg.error));
      if (msg.error.error_code) err.errorCode = msg.error.error_code;
      if (msg.error.remedy) err.remedy = msg.error.remedy;
      entry.reject(err);
    } else {
      entry.resolve(msg.result);
    }
  });
  ws.on("close", () => {
    clearInterval(keepalive);
    if (socket === ws) {
      socket = null;
      rejectPending("Chrome extension disconnected mid-call; retry once it reconnects.");
    }
  });
  ws.on("error", () => ws.terminate());
});
}

const server = new McpServer({ name: "opencode-chrome", version: "0.1.1" });

function releaseListener() {
  rejectPending("MCP client disconnected.");
  if (wss) {
    for (const client of wss.clients) client.terminate();
    wss.close();
  }
  server.close().catch(() => {});
}

// Sin peers, el listener no sobrevive al cliente stdio: suelta el puerto.
// Con peers, el primer cliente puede irse y los otros siguen usando la extensión.
process.stdin.once("end", () => {
  stdioClosed = true;
  if (peerMode) {
    for (const entry of peerPending.values()) {
      clearTimeout(entry.timer);
      entry.reject(
        toolError("extension_disconnected", "retry once the bridge is back", "MCP client disconnected.")
      );
    }
    peerPending.clear();
    try {
      peerSocket?.terminate();
    } catch {}
    try {
      wss?.close();
    } catch {}
    server.close().catch(() => {});
    return;
  }
  if (peers.size === 0) releaseListener();
  else rejectPending("MCP client disconnected.");
});

async function handleTool(tool, args) {
  try {
    if (tool === "list_recipes")
      return { content: [{ type: "text", text: JSON.stringify({ recipes: listRecipes() }) }] };
    if (tool === "run_recipe") {
      const recipe = loadRecipe(args?.name);
      if (!recipe) {
        const error = {
          message: `unknown recipe: ${args?.name}`,
          error_code: "unknown_recipe",
          remedy: "run list_recipes, or create ~/.config/opencode-chrome/adapters/<name>.json",
        };
        return { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true };
      }
      args = { ...args, recipe };
    }
    let result = await callExtension(tool, args);
    // output_path: el payload pesado (snapshot/screenshot/body/text) se escribe a
    // archivo aquí, en el bridge — la extensión no tiene acceso a fs
    try {
      const written = outputToFile(tool, args, result);
      if (written) result = written;
    } catch (e) {
      const error = {
        message: `output_path: ${e.message}`,
        error_code: "output_write_failed",
        remedy: "pick a writable absolute path; parent directories are not created",
      };
      return { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true };
    }
    if (tool === "wait_download" && result && typeof result.path === "string") {
      try {
        result.sha256 = createHash("sha256").update(readFileSync(result.path)).digest("hex");
      } catch {
        result.sha256 = null; // file moved or locked: report the path anyway
      }
    }
    if (result && typeof result === "object" && typeof result.image === "string") {
      return { content: [{ type: "image", data: result.image, mimeType: "image/png" }] };
    }
    const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const error = {
      message: err.message,
      error_code: err.errorCode ?? "internal_error",
      remedy: err.remedy ?? "retry the call; if it persists, report this message",
    };
    return { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true };
  }
}

await bound;
registerTools(server, (tool, args) => (peerMode ? callPeer(tool, args) : handleTool(tool, args)));
await server.connect(new StdioServerTransport());
