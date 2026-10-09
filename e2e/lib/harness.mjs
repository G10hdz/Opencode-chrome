// Real-Chrome e2e harness.
//
// Launch model (verified against branded Chrome 154 on this repo):
// - We spawn Chrome ourselves with --remote-debugging-port. Playwright's own
//   launchPersistentContext loads the extension as a silent no-op
//   (Extensions.getExtensions stays empty, the worker never starts) and also
//   blocks navigation to chrome-extension:// pages.
// - The extension is installed via the browser-level CDP method
//   Extensions.loadUnpacked, because branded Chrome ignores --load-extension
//   on fresh profiles.
// - The MV3 service worker only runs while an event keeps it awake and
//   disappears from /json/list when suspended. The extension registers
//   tabs.onUpdated/onRemoved/onInstalled/onStartup listeners, so installing
//   it starts the worker once, and creating or updating a tab wakes it again.
//   Poll /json/list and prod with a tab every few seconds while waiting.
// - chrome.storage.local {token, port} pairing is the same write options.js
//   performs on save; the 'reconnect' alarm fires the extension's existing
//   keepalive handler -> connect(). Evaluated in the worker over a raw
//   DevTools socket — the one surface Playwright cannot reach.
//
// Declared simulacrum: the attach record is seeded with the same
// chrome.storage.session write that toggleAttachment performs after the
// action click, because toolbar action clicks are not automatable.

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { CdpSocket, McpClient } from './rpc.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function chromeBin() {
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

// routes: { '/path': htmlString | (req, res) => void }
export async function startFixture(routes) {
  const port = await pickFreePort();
  const srv = createServer((req, res) => {
    const route = routes[new URL(req.url, 'http://x').pathname];
    if (!route) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (typeof route === 'function') return route(req, res);
    res.setHeader('content-type', 'text/html');
    res.end(route);
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { server: srv, origin: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

async function swSocket(devtoolsPort, extensionId, tabProd) {
  const list = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
  const t = list.find(
    (t) => t.type === 'service_worker' && t.url === `chrome-extension://${extensionId}/background.js`
  );
  if (!t) {
    await tabProd();
    return null;
  }
  const sw = await CdpSocket.connect(t.webSocketDebuggerUrl);
  const name = await sw.evaluate('chrome.runtime.getManifest().name').catch(() => null);
  if (name !== 'opencode-chrome') {
    sw.ws.close();
    return null;
  }
  return sw;
}

// One real environment per worker: Chrome + extension + bridge + MCP client.
export async function startEnv() {
  const bin = chromeBin();
  if (!bin) throw new Error('no Chrome binary found; set OPENCODE_CHROME_BIN');
  const devtoolsPort = await pickFreePort();
  const bridgePort = await pickFreePort();
  const token = `e2e-${randomUUID().slice(0, 8)}`;
  const profile = mkdtempSync(join(tmpdir(), 'oc-e2e-profile-'));

  const chrome = spawn(bin, [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${devtoolsPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--password-store=basic',
    'about:blank',
  ]);

  const bridge = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    env: {
      ...process.env,
      OPENCODE_CHROME_PORT: String(bridgePort),
      OPENCODE_CHROME_TOKEN: token,
      OPENCODE_CHROME_TIMEOUT_MS: '15000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (process.env.E2E_DEBUG)
    bridge.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));

  const env = { chrome, bridge, devtoolsPort, extensionId: null, sw: null, profile };
  try {
    await until('devtools endpoint', 20000, async () => {
      const r = await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`);
      return r.ok ? r.json() : null;
    });
    env.browser = await chromium.connectOverCDP(`http://127.0.0.1:${devtoolsPort}`);
    env.context = env.browser.contexts()[0];
    env.cdp = await env.browser.newBrowserCDPSession();

    // Both debugger clients see Page.javascriptDialogOpening: the extension
    // answers it and Playwright's internal session tries to answer the same
    // one ("No dialog is showing", surfacing as an unrelated test error).
    // Registering a dialog listener stops Playwright's auto-answer so the
    // extension under test owns the dialog.
    const ownDialogs = (page) => page.on('dialog', () => {});
    env.context.on('page', ownDialogs);
    for (const page of env.context.pages()) ownDialogs(page);

    const { id } = await env.cdp.send('Extensions.loadUnpacked', {
      path: realpathSync(join(ROOT, 'extension')),
    });
    env.extensionId = id;

    // Tab prod wakes the worker: tabs.onUpdated is registered.
    let lastProd = 0;
    env.sw = await until('service worker', 30000, () =>
      swSocket(devtoolsPort, id, async () => {
        if (Date.now() - lastProd < 3000) return;
        lastProd = Date.now();
        await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, { method: 'PUT' }).catch(() => {});
      })
    );

    // Pair: storage.local write + one-shot alarm -> connect().
    await env.sw.evaluate(
      `chrome.storage.local.set({token: ${JSON.stringify(token)}, port: ${bridgePort}})` +
        `.then(() => chrome.alarms.create('reconnect', {when: Date.now() + 50}))` +
        `.then(() => 'paired')`
    );

    env.mcp = new McpClient(bridge);
    await env.mcp.handshake();
    await until('extension connected', 45000, async () => {
      const s = await env.mcp.call('browser_status').catch(() => null);
      return s?.connected === true ? true : null;
    });
  } catch (e) {
    await stopEnv(env);
    throw e;
  }
  return env;
}

// Ensure the worker is awake and return a live socket to it.
export async function getSw(env) {
  if (env.sw?.ws.readyState === 1) return env.sw;
  let lastProd = 0;
  env.sw = await until('service worker', 90000, () =>
    swSocket(env.devtoolsPort, env.extensionId, async () => {
      if (Date.now() - lastProd < 3000) return;
      lastProd = Date.now();
      await fetch(`http://127.0.0.1:${env.devtoolsPort}/json/new?about:blank`, { method: 'PUT' }).catch(() => {});
    })
  );
  return env.sw;
}

// Same write toggleAttachment performs after chrome.action.onClicked. Then
// waits for the tab to commit its URL: chrome.tabs.create resolves before
// navigation commits, and attachedTab checks tab.url against the stored
// origin — resolving earlier would race the load and fail the origin check.
export async function seedAttach(env, tabId, origin) {
  const sw = await getSw(env);
  const ready = await sw.evaluate(`(async () => {
    const {attachments = {}} = await chrome.storage.session.get('attachments');
    attachments[String(${tabId})] = {origin: ${JSON.stringify(origin)}, attachedAt: Date.now()};
    await chrome.storage.session.set({attachments});
    for (let i = 0; i < 80; i++) {
      const t = await chrome.tabs.get(${tabId});
      if (t.status === 'complete' && t.url && t.url.startsWith(${JSON.stringify(origin)})) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  })()`);
  if (!ready) throw new Error(`tab ${tabId} never committed ${origin}`);
}

export async function stopEnv(env) {
  env.sw?.ws.close();
  await env.browser?.close().catch(() => {});
  env.bridge?.kill('SIGKILL');
  if (env.chrome && env.chrome.exitCode === null) {
    env.chrome.kill('SIGKILL');
    // rmSync of the profile races Chrome's last writes unless the process is
    // fully dead first (ENOTEMPTY on Default/).
    await Promise.race([
      new Promise((r) => env.chrome.once('exit', r)),
      sleep(5000),
    ]);
  }
  if (env.profile) rmSync(env.profile, { recursive: true, force: true });
}
