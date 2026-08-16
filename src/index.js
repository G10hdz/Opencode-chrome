#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { registerTools } from "./tools.js";

const PORT = parseInt(process.env.OPENCODE_CHROME_PORT, 10) || 9223;
const TIMEOUT_MS = parseInt(process.env.OPENCODE_CHROME_TIMEOUT_MS, 10) || 30000;

let socket = null;
let nextId = 1;
const pending = new Map();

function notConnected() {
  return new Error(
    `Chrome extension not connected on ws://127.0.0.1:${PORT}. ` +
      `Open Chrome, or reload the opencode-chrome extension in chrome://extensions, then retry.`
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
  if (socket && socket.readyState === socket.OPEN) {
    socket.close(1000, "replaced by newer connection");
  }
  socket = ws;
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

const server = new McpServer({ name: "opencode-chrome", version: "0.1.0" });

registerTools(server, async (tool, args) => {
  try {
    const result = await callExtension(tool, args);
    const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
