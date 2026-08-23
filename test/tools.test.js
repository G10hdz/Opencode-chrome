import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const INDEX = fileURLToPath(new URL('../src/index.js', import.meta.url));
const TOOL_TIMEOUT_MS = 500;
const MCP_DEADLINE_MS = 10000;
const BRIDGE_TOKEN = 'itest-token';
const EXPECTED_TOOLS = [
  'browser_status',
  'activate_tab',
  'click',
  'close_tab',
  'list_tabs',
  'navigate',
  'new_tab',
  'screenshot',
  'snapshot',
  'type',
  'wait_for',
];

const liveChildren = [];
after(() => {
  for (const child of liveChildren) child.kill('SIGKILL');
});

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      if (n > 10) return reject(new Error('no free port in 20000-40000'));
      const port = 20000 + Math.floor(Math.random() * 20000);
      const srv = net.createServer();
      srv.once('error', () => attempt(n + 1));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
    };
    attempt(0);
  });
}

class Bridge {
  constructor(child, port) {
    this.child = child;
    this.port = port;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = [];
    this.exited = new Promise((resolve) =>
      child.once('exit', () => {
        // stderr legitimo del puente (logs) no es error; solo lo es que muera el proceso
        this.failPending(new Error(`bridge exited early:\n${this.stderrTail.join('')}`));
        resolve();
      })
    );
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      this.stderrTail.push(d);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      }
    });
  }

  failPending(err) {
    for (const settle of this.pending.values()) settle(Promise.reject(err));
    this.pending.clear();
  }

  static async start() {
    const port = await pickFreePort();
    const child = spawn(process.execPath, [INDEX], {
      env: {
        ...process.env,
        OPENCODE_CHROME_PORT: String(port),
        OPENCODE_CHROME_TIMEOUT_MS: String(TOOL_TIMEOUT_MS),
        OPENCODE_CHROME_TOKEN: BRIDGE_TOKEN,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    liveChildren.push(child);
    const bridge = new Bridge(child, port);
    await withTimeout(
      bridge.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      }),
      MCP_DEADLINE_MS,
      'initialize',
    );
    bridge.notify('notifications/initialized');
    return bridge;
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async callTool(name, args = {}) {
    return withTimeout(
      this.request('tools/call', { name, arguments: args }),
      MCP_DEADLINE_MS,
      `tools/call ${name}`,
    );
  }

  async stop() {
    this.child.kill('SIGKILL');
    await this.exited;
    const i = liveChildren.indexOf(this.child);
    if (i >= 0) liveChildren.splice(i, 1);
  }
}

// Normaliza respuesta MCP de tool: JSON-RPC error o result{isError, content}
function outcome(response) {
  if (response.error) {
    return { isError: true, text: String(response.error.message ?? '') };
  }
  const result = response.result ?? {};
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return { isError: result.isError === true, text };
}

async function connectExtension(port, handler, { token = BRIDGE_TOKEN } = {}) {
  const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  const open = async () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { origin: 'chrome-extension://test-extension' });
      ws.once('open', () => resolve(ws));
      ws.once('error', (err) => {
        ws.terminate();
        reject(err);
      });
    });
  let lastErr;
  for (let i = 0; i < 50; i++) {
    try {
      const ws = await open();
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        handler(msg, (payload) => ws.send(JSON.stringify(payload)));
      });
      return ws;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`extension could not connect: ${lastErr}`);
}

async function startBridge(t) {
  const bridge = await Bridge.start();
  t.after(() => bridge.stop());
  return bridge;
}

test('initialize handshake and tools/list expose the expected tools', async (t) => {
  const bridge = await startBridge(t);
  const response = await withTimeout(
    bridge.request('tools/list', {}),
    MCP_DEADLINE_MS,
    'tools/list',
  );
  assert.ok(!response.error, `tools/list failed: ${JSON.stringify(response.error)}`);
  const names = (response.result.tools ?? []).map((tool) => tool.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
});

test('tool call without extension connected errors mentioning Chrome', async (t) => {
  const bridge = await startBridge(t);
  const { isError, text } = outcome(await bridge.callTool('list_tabs'));
  assert.equal(isError, true);
  assert.match(text, /chrome/i);
});

test('tool call roundtrips result through fake extension', async (t) => {
  const bridge = await startBridge(t);
  const ws = await connectExtension(bridge.port, (msg, reply) => {
    assert.equal(msg.tool, 'list_tabs');
    reply({ id: msg.id, result: [{ id: 1, title: 'Example', url: 'https://example.test/' }] });
  });
  t.after(() => ws.close());
  const { isError, text } = outcome(await bridge.callTool('list_tabs'));
  assert.equal(isError, false);
  assert.match(text, /example\.test/);
});

test('extension error propagates to tool result', async (t) => {
  const bridge = await startBridge(t);
  const ws = await connectExtension(bridge.port, (msg, reply) => {
    reply({ id: msg.id, error: { message: 'tab cerrada' } });
  });
  t.after(() => ws.close());
  const { isError, text } = outcome(await bridge.callTool('close_tab', { id: 7 }));
  assert.equal(isError, true);
  assert.match(text, /tab cerrada/);
});

test('missing extension reply times out', async (t) => {
  const bridge = await startBridge(t);
  const ws = await connectExtension(bridge.port, () => {});
  t.after(() => ws.close());
  const startedAt = Date.now();
  const { isError, text } = outcome(await bridge.callTool('snapshot'));
  assert.equal(isError, true);
  assert.match(text, /timeout|did not respond|within \d+ms/i);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < MCP_DEADLINE_MS, `took ${elapsed}ms, expected fast timeout error`);
});

test('concurrent tool calls keep their responses matched by id', async (t) => {
  const bridge = await startBridge(t);
  const ws = await connectExtension(bridge.port, (msg, reply) => {
    if (msg.tool === 'list_tabs') {
      // respuesta lenta: la llamada rápida vuelve primero
      setTimeout(() => reply({ id: msg.id, result: { echo: 'slow-list_tabs' } }), 150);
    } else {
      reply({ id: msg.id, result: { echo: 'fast-new_tab' } });
    }
  });
  t.after(() => ws.close());
  const [slow, fast] = await Promise.all([
    bridge.callTool('list_tabs'),
    bridge.callTool('new_tab', { url: 'https://example.test/' }),
  ]);
  const slowOut = outcome(slow);
  const fastOut = outcome(fast);
  assert.equal(slowOut.isError, false);
  assert.equal(fastOut.isError, false);
  assert.match(slowOut.text, /slow-list_tabs/);
  assert.doesNotMatch(slowOut.text, /fast-new_tab/);
  assert.match(fastOut.text, /fast-new_tab/);
  assert.doesNotMatch(fastOut.text, /slow-list_tabs/);
});

test('unknown tool errors', async (t) => {
  const bridge = await startBridge(t);
  const { isError } = outcome(await bridge.callTool('no_such_tool'));
  assert.equal(isError, true);
});

test('connection without a valid token is refused with close code 1008', async (t) => {
  const bridge = await startBridge(t);
  const closed = new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, {
      origin: 'chrome-extension://test-extension',
    });
    ws.once('close', (code) => resolve(code));
    ws.once('error', () => {});
  });
  assert.equal(await withTimeout(closed, 5000, 'token reject'), 1008);
});

test('screenshot result comes back as MCP image content', async (t) => {
  const bridge = await startBridge(t);
  const ws = await connectExtension(bridge.port, (msg, reply) => {
    reply({ id: msg.id, result: { image: 'aGVsbG8=' } });
  });
  t.after(() => ws.close());
  const response = await bridge.callTool('screenshot');
  const content = response.result?.content ?? [];
  assert.equal(content[0]?.type, 'image');
  assert.equal(content[0]?.mimeType, 'image/png');
  assert.equal(content[0]?.data, 'aGVsbG8=');
});
