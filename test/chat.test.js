import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const INDEX = fileURLToPath(new URL('../src/index.js', import.meta.url));
const BRIDGE_TOKEN = 'itest-chat-token';
const API_KEY = 'sk-test-SECRET-key';
const FRAME_TIMEOUT_MS = 8000;

const liveChildren = [];
after(() => {
  for (const child of liveChildren) child.kill('SIGKILL');
});

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      if (n > 10) return reject(new Error('no free port'));
      const port = 20000 + Math.floor(Math.random() * 20000);
      const srv = net.createServer();
      srv.once('error', () => attempt(n + 1));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
    };
    attempt(0);
  });
}

// Puente en --serve: solo WS + chat, sin handshake MCP.
async function startServe(t, extraEnv = {}) {
  const port = await pickFreePort();
  const child = spawn(process.execPath, [INDEX, '--serve'], {
    env: {
      ...process.env,
      OPENCODE_CHROME_PORT: String(port),
      OPENCODE_CHROME_TIMEOUT_MS: '500',
      OPENCODE_CHROME_TOKEN: BRIDGE_TOKEN,
      OPENCODE_CHROME_CONFIG: join(tmpdir(), 'opencode-chrome-test-no-config.json'),
      OPENCODE_CHROME_CHAT: join(tmpdir(), 'opencode-chrome-test-no-chat.json'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveChildren.push(child);
  const stderrTail = [];
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge did not start')), FRAME_TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderrTail.push(d);
      if (d.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  child.once('exit', () => {
    const i = liveChildren.indexOf(child);
    if (i >= 0) liveChildren.splice(i, 1);
  });
  t.after(() => child.kill('SIGKILL'));
  await ready;
  return { child, port, stderrTail };
}

// Provider falso: cola de respuestas SSE + captura de requests para aserciones.
async function fakeProvider(t, script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const entry = { url: req.url, headers: req.headers, body: JSON.parse(body || '{}') };
      requests.push(entry);
      const step = script.length > 1 ? script.shift() : script[0];
      try {
        step(entry, res);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { requests, port: server.address().port };
}

const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
};

const oaiText = (text) => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
];

const oaiTool = (id, name, args) => [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  },
];

// Extensión falsa: contesta tool calls y acumula frames chat_*.
async function connectChat(port, onTool) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${BRIDGE_TOKEN}`, {
    origin: 'chrome-extension://test-extension',
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const frames = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (typeof msg.tool === 'string') {
      const reply = onTool?.(msg) ?? { ok: true };
      ws.send(
        JSON.stringify(reply.error ? { id: msg.id, error: reply.error } : { id: msg.id, result: reply })
      );
      return;
    }
    frames.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  const next = (pred, ms = FRAME_TIMEOUT_MS) => {
    const hit = frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no matching frame; got ${JSON.stringify(frames)}`)),
        ms
      );
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  };
  return { ws, frames, next, send: (f) => ws.send(JSON.stringify(f)) };
}

const isChat = (key) => (m) => m[key] !== undefined;

test('chat turn without chat.json fails with chat_not_configured', async (t) => {
  const { port } = await startServe(t);
  const ext = await connectChat(port);
  t.after(() => ext.ws.close());
  ext.send({ chat: { id: 1, text: 'hi' } });
  const err = await ext.next(isChat('chat_error'));
  assert.equal(err.chat_error.id, 1);
  assert.match(err.chat_error.message, /chat_not_configured/);
});

test('openai provider streams text deltas and finishes', async (t) => {
  const provider = await fakeProvider(t, [
    (_req, res) => sse(res, oaiText('Hello world')),
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'oc-chat-'));
  const chatFile = join(dir, 'chat.json');
  writeFileSync(
    chatFile,
    JSON.stringify({
      provider: 'openai',
      base_url: `http://127.0.0.1:${provider.port}`,
      api_key: API_KEY,
      model: 'fake-model',
    }),
    { mode: 0o600 }
  );
  const { port } = await startServe(t, { OPENCODE_CHROME_CHAT: chatFile });
  const ext = await connectChat(port);
  t.after(() => ext.ws.close());
  ext.send({ chat: { id: 1, text: 'hi' } });
  const delta = await ext.next(isChat('chat_delta'));
  assert.equal(delta.chat_delta.text, 'Hello world');
  const done = await ext.next(isChat('chat_done'));
  assert.equal(done.chat_done.id, 1);
  assert.equal(done.chat_done.truncated, undefined);
  const req = provider.requests[0];
  assert.equal(req.headers.authorization, `Bearer ${API_KEY}`);
  assert.ok(Array.isArray(req.body.tools) && req.body.tools.length > 30);
  assert.equal(req.body.messages[0].role, 'system');
});

test('read tool runs without confirm; result wrapped in untrusted_web_content', async (t) => {
  const provider = await fakeProvider(t, [
    (_req, res) => sse(res, oaiTool('call_1', 'list_tabs', {})),
    (req, res) => {
      const toolMsg = req.body.messages.findLast((m) => m.role === 'tool');
      assert.ok(toolMsg, 'tool result message missing');
      assert.match(toolMsg.content, /<untrusted_web_content>/);
      assert.match(toolMsg.content, /example\.test/);
      sse(res, oaiText('found one tab'));
    },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'oc-chat-'));
  const chatFile = join(dir, 'chat.json');
  writeFileSync(
    chatFile,
    JSON.stringify({
      provider: 'openai',
      base_url: `http://127.0.0.1:${provider.port}`,
      api_key: API_KEY,
      model: 'fake',
    })
  );
  const { port } = await startServe(t, { OPENCODE_CHROME_CHAT: chatFile });
  const ext = await connectChat(port, (msg) => {
    assert.equal(msg.tool, 'list_tabs');
    return [{ id: 7, title: 'T', url: 'https://example.test/' }];
  });
  t.after(() => ext.ws.close());
  ext.send({ chat: { id: 2, text: 'what tabs?' } });
  const done = await ext.next(isChat('chat_done'));
  assert.equal(done.chat_done.id, 2);
  assert.ok(!ext.frames.some(isChat('chat_confirm')), 'read tool must not ask for confirmation');
  assert.ok(ext.frames.some((f) => f.chat_tool?.phase === 'result' && f.chat_tool?.name === 'list_tabs'));
});

test('write tool pauses on chat_confirm and runs after approval', async (t) => {
  const provider = await fakeProvider(t, [
    (_req, res) => sse(res, oaiTool('call_9', 'click', { ref: 3 })),
    (_req, res) => sse(res, oaiText('clicked it')),
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'oc-chat-'));
  const chatFile = join(dir, 'chat.json');
  writeFileSync(
    chatFile,
    JSON.stringify({
      provider: 'openai',
      base_url: `http://127.0.0.1:${provider.port}`,
      api_key: API_KEY,
      model: 'fake',
    })
  );
  const { port } = await startServe(t, { OPENCODE_CHROME_CHAT: chatFile });
  const calls = [];
  const ext = await connectChat(port, (msg) => {
    calls.push(msg.tool);
    return { clicked: true };
  });
  t.after(() => ext.ws.close());
  ext.send({ chat: { id: 3, text: 'click the button' } });
  const confirm = await ext.next(isChat('chat_confirm'));
  assert.equal(confirm.chat_confirm.tool, 'click');
  assert.deepEqual(calls, [], 'write tool ran before approval');
  ext.send({ chat_answer: { id: 3, cid: confirm.chat_confirm.cid, approved: true } });
  await ext.next(isChat('chat_done'));
  assert.deepEqual(calls, ['click']);
});

test('denied write tool is not dispatched and is reported back', async (t) => {
  const provider = await fakeProvider(t, [
    (_req, res) => sse(res, oaiTool('call_9', 'click', { ref: 3 })),
    (req, res) => {
      const toolMsg = req.body.messages.findLast((m) => m.role === 'tool');
      assert.match(toolMsg?.content ?? '', /user_denied/);
      sse(res, oaiText('ok, skipping'));
    },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'oc-chat-'));
  const chatFile = join(dir, 'chat.json');
  writeFileSync(
    chatFile,
    JSON.stringify({
      provider: 'openai',
      base_url: `http://127.0.0.1:${provider.port}`,
      api_key: API_KEY,
      model: 'fake',
    })
  );
  const { port } = await startServe(t, { OPENCODE_CHROME_CHAT: chatFile });
  const calls = [];
  const ext = await connectChat(port, (msg) => {
    calls.push(msg.tool);
    return { clicked: true };
  });
  t.after(() => ext.ws.close());
  ext.send({ chat: { id: 4, text: 'click it' } });
  const confirm = await ext.next(isChat('chat_confirm'));
  ext.send({ chat_answer: { id: 4, cid: confirm.chat_confirm.cid, approved: false } });
  await ext.next(isChat('chat_done'));
  assert.deepEqual(calls, []);
});

test('a peer socket cannot use chat', async (t) => {
  const { port } = await startServe(t);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${BRIDGE_TOKEN}&role=peer`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  t.after(() => ws.close());
  const reply = new Promise((resolve) =>
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())))
  );
  ws.send(JSON.stringify({ chat: { id: 1, text: 'hi' } }));
  const msg = await reply;
  assert.match(msg.chat_error?.message ?? '', /only available on the Chrome extension/);
});

test('max_turns ends the loop with a truncated marker', async (t) => {
  const provider = await fakeProvider(t, [
    (_req, res) => sse(res, oaiTool('call_x', 'list_tabs', {})),
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'oc-chat-'));
  const chatFile = join(dir, 'chat.json');
  writeFileSync(
    chatFile,
    JSON.stringify({
      provider: 'openai',
      base_url: `http://127.0.0.1:${provider.port}`,
      api_key: API_KEY,
      model: 'fake',
      max_turns: 2,
    })
  );
  const { port } = await startServe(t, { OPENCODE_CHROME_CHAT: chatFile });
  const ext = await connectChat(port, () => []);
  t.after(() => ext.ws.close());
  ext.send({ chat: { id: 5, text: 'loop' } });
  const done = await ext.next(isChat('chat_done'));
  assert.equal(done.chat_done.truncated, 'max_turns');
});

test('provider errors never echo the api key', async (t) => {
  const provider = await fakeProvider(t, [
    (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `invalid key ${API_KEY}` }));
    },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'oc-chat-'));
  const chatFile = join(dir, 'chat.json');
  writeFileSync(
    chatFile,
    JSON.stringify({
      provider: 'openai',
      base_url: `http://127.0.0.1:${provider.port}`,
      api_key: API_KEY,
      model: 'fake',
    })
  );
  const { port } = await startServe(t, { OPENCODE_CHROME_CHAT: chatFile });
  const ext = await connectChat(port);
  t.after(() => ext.ws.close());
  ext.send({ chat: { id: 6, text: 'hi' } });
  const err = await ext.next(isChat('chat_error'));
  assert.ok(!err.chat_error.message.includes(API_KEY), 'api key leaked in chat_error');
  assert.match(err.chat_error.message, /\[redacted\]/);
});

test('anthropic provider maps tools and merges tool results in one user message', async (t) => {
  const anthropicText = (text) => [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
  const anthropicTool = (id, name, input) => [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
  const provider = await fakeProvider(t, [
    (req, res) => {
      assert.equal(req.url, '/v1/messages');
      assert.equal(req.headers['x-api-key'], API_KEY);
      assert.equal(req.headers['anthropic-version'], '2023-06-01');
      assert.ok(req.body.tools.every((tool) => tool.input_schema?.type === 'object'));
      sse(res, anthropicTool('toolu_1', 'list_tabs', {}));
    },
    (req, res) => {
      const toolUsers = req.body.messages.filter(
        (m) => m.role === 'user' && m.content?.[0]?.type === 'tool_result'
      );
      assert.equal(toolUsers.length, 1, 'tool_result not merged into a single user message');
      assert.match(toolUsers[0].content[0].content, /<untrusted_web_content>/);
      sse(res, anthropicText('done'));
    },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'oc-chat-'));
  const chatFile = join(dir, 'chat.json');
  writeFileSync(
    chatFile,
    JSON.stringify({
      provider: 'anthropic',
      base_url: `http://127.0.0.1:${provider.port}`,
      api_key: API_KEY,
      model: 'claude-fake',
    })
  );
  const { port } = await startServe(t, { OPENCODE_CHROME_CHAT: chatFile });
  const ext = await connectChat(port, () => []);
  t.after(() => ext.ws.close());
  ext.send({ chat: { id: 7, text: 'tabs?' } });
  const done = await ext.next(isChat('chat_done'));
  assert.equal(done.chat_done.id, 7);
});
