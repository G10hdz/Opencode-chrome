#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { registerTools } from "./tools.js";
import { spawnSync } from "node:child_process";

// default 19223 — 9223 is often taken by Electron --remote-debugging-port (OpenWork, etc.)
const PORT = parseInt(process.env.OPENCODE_CHROME_PORT, 10) || 19223;
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

const POLICY = loadPolicy();
if (Object.keys(POLICY.origin_allowlist).length)
  console.error(`opencode-chrome: origin allowlist for ${Object.keys(POLICY.origin_allowlist).length} origin(s)`);

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
    `Chrome extension not connected on ws://127.0.0.1:${PORT}. ` +
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

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin;
  if (origin && !origin.startsWith("chrome-extension://")) {
    ws.close(1008, "origin not allowed");
    return;
  }
  const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
  if (token !== TOKEN) {
    ws.close(1008, "invalid token");
    return;
  }
  if (socket) {
    rejectPending("Chrome extension connection replaced mid-call; check the page before retrying.");
    socket.terminate();
  }
  socket = ws;
  // la policy se empuja en cada conexión: una reconexión con otro bridge resetea la allowlist
  ws.send(JSON.stringify({ policy: POLICY }));
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

wss.on("error", (err) => {
  console.error(
    `opencode-chrome: cannot listen on 127.0.0.1:${PORT} (${err.code ?? err.message})`
  );
  process.exit(1);
});

const server = new McpServer({ name: "opencode-chrome", version: "0.1.1" });

// The WebSocket listener must not outlive its stdio client and keep the port busy.
process.stdin.once("end", () => {
  rejectPending("MCP client disconnected.");
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.close().catch(() => {});
});

registerTools(server, async (tool, args) => {
  try {
    const result = await callExtension(tool, args);
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
});

await server.connect(new StdioServerTransport());
