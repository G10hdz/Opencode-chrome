#!/usr/bin/env node
// E2E smoke: real Chrome + real extension + real bridge over MCP stdio.
// NOT part of `npm test` — needs a Chrome binary and writes to a temp profile.
// Run by hand:
//   node scripts/e2e-smoke.mjs
//   OPENCODE_CHROME_BIN=/path/to/chrome   (auto-detected otherwise)
//   SMOKE_HEADLESS=1                      (--headless=new; extensions need a recent Chrome)
//
// Declared simulacra: (1) the attach step writes the same storage.session
// record that chrome.action.onClicked -> toggleAttachment writes, evaluated in
// the live service worker (action clicks are not automatable); (2) the token
// pairing writes storage.local like options.js does, same way. Everything else
// is the shipped path: MCP over stdio -> bridge WS -> extension ->
// chrome.debugger -> the page.

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = `smoke-${randomUUID().slice(0, 8)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- machine-checkable step report ---
const steps = [];
async function step(name, fn) {
  try {
    const detail = await fn();
    steps.push({ name, ok: true });
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
    return detail;
  } catch (err) {
    steps.push({ name, ok: false });
    console.log(`FAIL ${name} — ${err.message}`);
    throw err; // later steps depend on earlier state
  }
}

async function until(label, deadline, fn) {
  const end = Date.now() + deadline;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (${last.message})` : ''}`);
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function chromeBin() {
  const cands = [
    process.env.OPENCODE_CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ].filter(Boolean);
  for (const c of cands) {
    if (c.includes('/') ? existsSync(c) : spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0)
      return c;
  }
  return null;
}

// Branded Chrome ignores --load-extension on fresh profiles (observed on 154:
// no target, no prefs entry). The deterministic path is the browser-level CDP
// method Extensions.loadUnpacked, which also returns the extension id.
async function loadExtension(devtoolsPort, extPath) {
  const { webSocketDebuggerUrl } = await (
    await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`)
  ).json();
  const browser = new CdpSocket(new WebSocket(webSocketDebuggerUrl));
  try {
    await until('browser ws', 5000, async () => (browser.ws.readyState === 1 ? true : null));
    // The Extensions domain registers after the DevTools endpoint is already
    // serving; early calls can be dropped, so retry on a short timeout.
    const r = await until('Extensions.loadUnpacked response', 30000, async () => {
      try {
        return await browser.request('Extensions.loadUnpacked', { path: extPath }, 5000);
      } catch {
        return null;
      }
    });
    if (!r?.id) throw new Error(`Extensions.loadUnpacked returned ${JSON.stringify(r)}`);
    return r.id;
  } finally {
    browser.ws.close();
  }
}

// The MV3 service worker only runs while an event keeps it awake; when idle it
// suspends and disappears from /json/list. The extension registers
// tabs.onUpdated/onRemoved listeners, so creating a tab through the DevTools
// HTTP endpoint is a deterministic wake. Prod at most every 3s while polling.
// (/json/new is PUT-only since Chrome ~111.)
let lastWakeProd = 0;
async function extensionSwSocket(devtoolsPort, extensionId) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
    const t = list.find(
      (t) => t.type === 'service_worker' && t.url === `chrome-extension://${extensionId}/background.js`
    );
    if (!t) {
      if (Date.now() - lastWakeProd > 3000) {
        lastWakeProd = Date.now();
        await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, { method: 'PUT' }).catch(() => {});
      }
      return null;
    }
    const sw = new CdpSocket(new WebSocket(t.webSocketDebuggerUrl));
    await until('sw ws', 5000, async () => (sw.ws.readyState === 1 ? true : null));
    const name = await sw.evaluate('chrome.runtime.getManifest().name').catch(() => null);
    if (name !== 'opencode-chrome') {
      sw.ws.close();
      return null;
    }
    return sw;
  } catch {
    return null;
  }
}

// Minimal JSON-RPC client for MCP stdio and CDP websockets. The browser-level
// DevTools endpoint rejects the 'jsonrpc' property outright (and its error
// reply carries no id, so a tagged request just hangs) — only MCP gets the tag.
class Rpc {
  constructor(jsonrpcTag = true) {
    this.jsonrpcTag = jsonrpcTag;
    this.nextId = 1;
    this.pending = new Map();
  }
  dispatch(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
      this.pending.get(msg.id)(msg);
      this.pending.delete(msg.id);
    }
  }
  request(method, params, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no response in ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      });
      this.send({ ...(this.jsonrpcTag ? { jsonrpc: '2.0' } : {}), id, method, params });
    });
  }
}

class CdpSocket extends Rpc {
  constructor(ws) {
    super(false);
    this.ws = ws;
    ws.on('message', (d) => this.dispatch(d.toString()));
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  // The service worker has a single execution context (chrome.* present), so a
  // plain evaluate lands in the right place — Runtime.enable/ contextId is
  // only needed on page targets and has been observed to hang on
  // chrome-extension:// targets.
  async evaluate(expr) {
    const r = await this.request('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r?.exceptionDetails) throw new Error(`page eval: ${JSON.stringify(r.exceptionDetails.text)}`);
    return r?.result?.value;
  }
}

const FIXTURE_HTML = `<!doctype html><meta charset="utf-8"><title>smoke fixture</title>
<body>
<button id="go" onclick="this.innerText='clicked';document.getElementById('out').innerText='done'">go</button>
<input id="name" placeholder="name" autocomplete="off">
<p id="out">idle</p>
</body>`;

async function main() {
  const bin = chromeBin();
  if (!bin) throw new Error('no Chrome binary found; set OPENCODE_CHROME_BIN');
  const [devtoolsPort, bridgePort, fixturePort] = await Promise.all([pickFreePort(), pickFreePort(), pickFreePort()]);

  const fixture = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(FIXTURE_HTML);
  });
  await new Promise((r) => fixture.listen(fixturePort, '127.0.0.1', r));
  const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;

  const profile = mkdtempSync(join(tmpdir(), 'oc-smoke-profile-'));
  const extPath = realpathSync(join(ROOT, 'extension'));
  const chromeArgs = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${devtoolsPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--password-store=basic',
    ...(process.env.SMOKE_HEADLESS ? ['--headless=new'] : []),
    'about:blank',
  ];
  const chrome = spawn(bin, chromeArgs);
  const bridge = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    env: {
      ...process.env,
      OPENCODE_CHROME_PORT: String(bridgePort),
      OPENCODE_CHROME_TOKEN: TOKEN,
      OPENCODE_CHROME_TIMEOUT_MS: '15000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  bridge.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));

  try {
    const mcp = new Rpc();
    let buf = '';
    bridge.stdout.setEncoding('utf8');
    bridge.stdout.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        mcp.dispatch(buf.slice(0, idx).trim());
        buf = buf.slice(idx + 1);
      }
    });
    mcp.send = (obj) => bridge.stdin.write(`${JSON.stringify(obj)}\n`);
    const call = (name, args = {}) => mcp.request('tools/call', { name, arguments: args });
    const toolText = async (name, args) => {
      const r = await call(name, args);
      const content = r?.content ?? [];
      if (r?.isError) throw new Error(content.map((c) => c.text).join(' '));
      return content;
    };

    await step('mcp handshake', () =>
      mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } }).then(() => {
        bridge.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      })
    );

    await until('devtools endpoint', 20000, async () => {
      const r = await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`);
      return r.ok ? r.json() : null;
    });

    // Load the extension over CDP (browser target), which returns its id —
    // no --load-extension flag, no profile-prefs probing.
    let extensionId;
    await step('Extensions.loadUnpacked', async () => {
      extensionId = await loadExtension(devtoolsPort, extPath);
      return extensionId;
    });

    // Pairing = the same storage.local write options.js does on save, then a
    // one-shot 'reconnect' alarm that fires the existing keepalive handler ->
    // connect() (the worker is a module: top-level functions are not reachable
    // from Runtime.evaluate, and runtime.sendMessage cannot self-deliver).
    let sw;
    await step('service worker discovered', async () => {
      sw = await until('opencode-chrome service worker', 60000, () => extensionSwSocket(devtoolsPort, extensionId));
    });
    await step('token pairing', async () => {
      const paired = await sw.evaluate(
        `chrome.storage.local.set({token: ${JSON.stringify(TOKEN)}, port: ${bridgePort}})` +
          `.then(() => chrome.alarms.create('reconnect', {when: Date.now() + 50}))` +
          `.then(() => 'paired')`
      );
      if (paired !== 'paired') throw new Error(`unexpected result: ${paired}`);
    });

    await step('extension connects to bridge', () =>
      until('browser_status connected:true', 45000, async () => {
        const c = await toolText('browser_status');
        const s = JSON.parse(c[0]?.text ?? 'null');
        return s?.connected === true ? true : null;
      })
    );

    // Fixture tab via the real new_tab tool; attach record seeded in the worker
    // context (same write toggleAttachment does after the action click).
    // A suspended worker disappears from /json/list; its 1-minute keepalive
    // alarm wakes it again, so the deadline must survive one alarm cycle.
    if (sw.ws.readyState !== 1)
      sw = await until('service worker for attach seed', 90000, () => extensionSwSocket(devtoolsPort, extensionId));
    const tabId = await step('new_tab fixture', async () => {
      const c = await toolText('new_tab', { url: fixtureOrigin });
      const r = JSON.parse(c[0]?.text ?? 'null');
      if (typeof r?.id !== 'number') throw new Error(`bad response ${c[0]?.text}`);
      return r.id;
    });
    await step('attach (seeded record, see header note)', async () => {
      const id = await sw.evaluate(`(async () => {
        const [tab] = await chrome.tabs.query({url: ${JSON.stringify(fixtureOrigin + '/*')}});
        if (!tab) return null;
        const {attachments = {}} = await chrome.storage.session.get('attachments');
        attachments[String(tab.id)] = {origin: ${JSON.stringify(fixtureOrigin)}, attachedAt: Date.now()};
        await chrome.storage.session.set({attachments});
        return tab.id;
      })()`);
      if (id !== tabId) throw new Error(`seeded ${id}, expected ${tabId}`);
      await until('attachment visible in browser_status', 5000, async () => {
        const c = await toolText('browser_status');
        const s = JSON.parse(c[0]?.text ?? 'null');
        return s?.attached?.some((a) => a.tabId === tabId) ? true : null;
      });
    });

    await step('snapshot lists interactive refs', async () => {
      const c = await toolText('snapshot', { tabId });
      const text = c[0]?.text ?? '';
      if (!text.includes('[ref=') || !text.includes('button') || !text.includes('textbox'))
        throw new Error(`snapshot too small: ${text.slice(0, 120)}`);
      return `${text.length} chars`;
    });

    const clickRef = await step('find resolves the button ref', async () => {
      const c = await toolText('find', { text: 'go', tabId });
      const m = /\[ref=(\d+)\]/.exec(c[0]?.text ?? '');
      if (!m) throw new Error(`no ref in ${c[0]?.text}`);
      return Number(m[1]);
    });
    await step('click produces trusted page change', async () => {
      await toolText('click', { ref: clickRef, tabId });
      const c = await toolText('wait_for', { text: 'clicked', timeout: 5000, tabId });
      if (!JSON.parse(c[0]?.text ?? '{}').found) throw new Error('button text never changed');
    });

    const fillRef = await step('find resolves the input ref', async () => {
      const c = await toolText('find', { role: 'textbox', tabId });
      const m = /\[ref=(\d+)\]/.exec(c[0]?.text ?? '');
      if (!m) throw new Error(`no ref in ${c[0]?.text}`);
      return Number(m[1]);
    });
    await step('fill writes a visible value', async () => {
      await toolText('fill', { ref: fillRef, value: 'smoke-value', tabId });
      const c = await toolText('snapshot', { tabId });
      if (!(c[0]?.text ?? '').includes('smoke-value')) throw new Error('value not in fresh snapshot');
    });

    await step('screenshot returns png bytes', async () => {
      const c = await call('screenshot', { tabId });
      const img = (c?.content ?? []).find((x) => x.type === 'image');
      if (!img || img.mimeType !== 'image/png' || !img.data?.length) throw new Error('no image content');
      return `${img.data.length} b64 chars`;
    });
  } finally {
    chrome.kill('SIGKILL');
    bridge.kill('SIGKILL');
    fixture.close();
    rmSync(profile, { recursive: true, force: true });
  }

  const failed = steps.filter((s) => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} steps passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`smoke aborted: ${err.message}`);
  process.exit(1);
});
