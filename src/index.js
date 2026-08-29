#!/usr/bin/env node
import { randomUUID } from "node:crypto";
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

function notConnected() {
  return new Error(
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
      reject(new Error(`Extension did not respond to "${tool}" within ${TIMEOUT_MS}ms.`));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, tool, args }));
  });
}

function rejectPending(message) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
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
  if (socket && socket.readyState === socket.OPEN) {
    socket.close(1000, "replaced by newer connection");
  }
  socket = ws;
  // keepalive: no-op sin tool; la extension lo filtra y el SW recibe actividad que evita su suspension
  const keepalive = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id: -1 }));
  }, KEEPALIVE_MS);
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
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
});

wss.on("error", (err) => {
  console.error(
    `opencode-chrome: cannot listen on 127.0.0.1:${PORT} (${err.code ?? err.message})`
  );
  process.exit(1);
});

const server = new McpServer({ name: "opencode-chrome", version: "0.1.1" });

registerTools(server, async (tool, args) => {
  try {
    const result = await callExtension(tool, args);
    if (result && typeof result === "object" && typeof result.image === "string") {
      return { content: [{ type: "image", data: result.image, mimeType: "image/png" }] };
    }
    const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
