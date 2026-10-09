import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import * as policy from '../extension/policy.js';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

async function worker() {
  const sockets = [];
  const timers = new Map();
  const listeners = {};
  let nextTimer = 0;
  const event = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    sent = [];
    constructor() { sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    close() { this.readyState = 3; this.onclose?.(); }
    send(data) { this.sent.push(JSON.parse(data)); }
    receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  const chrome = {
    storage: { local: { get: async () => ({ token: 'test-token' }) }, session: { get: async () => ({}) } },
    tabs: { query: async () => [], onRemoved: event('removed'), onUpdated: event('updated') },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: event('clicked') },
    runtime: { onMessage: event('message') },
    alarms: { create() {}, onAlarm: event('alarm') },
    debugger: { onDetach: event('detach'), onEvent: event('cdpEvent') },
  };
  const ctx = {
    ...policy, chrome, WebSocket: Socket,
    setTimeout(fn, ms) { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  };
  runInNewContext(source.replace(/^import .*;\n/, ''), ctx);
  await setImmediate();
  return {
    sockets, chrome, listeners, timers, ctx,
    async fire(ms) {
      for (const [id, timer] of [...timers]) {
        if (timer.ms !== ms || !timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
      }
      await setImmediate();
    },
  };
}

test('manual reconnect cancels the pending retry', async () => {
  const w = await worker();
  w.sockets[0].close();
  w.listeners.message('reconnect');
  await setImmediate();
  w.sockets[1].open();
  await w.fire(3000);
  assert.equal(w.sockets.length, 2);
});

test('overlapping alarm wakeups only start one connection', async () => {
  const w = await worker();
  w.sockets[0].close();
  w.listeners.alarm({ name: 'reconnect' });
  w.listeners.alarm({ name: 'reconnect' });
  await setImmediate();
  assert.equal(w.sockets.length, 2);
});

test('a late result cannot cross into a replacement bridge connection', async () => {
  const w = await worker();
  const old = w.sockets[0];
  old.open();
  let finish;
  w.chrome.tabs.create = () => new Promise((resolve) => { finish = resolve; });
  old.receive({ id: 1, tool: 'new_tab', args: {} });
  w.listeners.message('reconnect');
  await setImmediate();
  const current = w.sockets[1];
  current.open();
  finish({ id: 7 });
  await setImmediate();
  assert.deepEqual(current.sent, []);
});

test('a silent connection is replaced and keepalives postpone recovery', async () => {
  const w = await worker();
  w.sockets[0].open();
  const timerIds = [...w.timers.keys()];
  w.sockets[0].receive({ id: -1 });
  assert.ok(timerIds.every((id) => !w.timers.has(id)));
  await w.fire(45000);
  assert.equal(w.sockets[0].readyState, 3);
  assert.equal(w.sockets.length, 2);
});

test('a connection stuck opening gets a fresh attempt', async () => {
  const w = await worker();
  await w.fire(10000);
  assert.equal(w.sockets[0].readyState, 3);
  assert.equal(w.sockets.length, 2);
});

// DOM mínimo para correr REF_CHECK_SCRIPT de verdad: querySelector por selector exacto,
// querySelectorAll sirve la lista de interactivos o lookups de #id (los usa selectorFor).
const INTERACTIVE_SEL = "a,button,input,select,textarea,[role],[onclick],[tabindex],summary";
function fakeEl(over) {
  return {
    nodeType: 1, tagName: 'BUTTON', id: '', className: '', type: undefined,
    labels: null, innerText: '', parentElement: null, childNodes: [],
    matches: () => true,
    getAttribute: () => null, getClientRects: () => [{}],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 10, bottom: 10 }),
    ...over,
  };
}
function fakeDom(els, bySel) {
  const document = {
    documentElement: { nodeType: 1 },
    querySelector: (s) => bySel[s] ?? null,
    querySelectorAll: (s) => {
      if (s === INTERACTIVE_SEL) return els;
      if (s.startsWith('#')) return els.filter((e) => e.id === s.slice(1));
      return [];
    },
  };
  return {
    document,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    CSS: { escape: (s) => s },
  };
}
const hashStr = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; };

test('ref fingerprint tiers: exact, reidentified, stable, gone', async () => {
  const w = await worker();
  const scriptFor = (sel, fp) => w.ctx.REF_CHECK_SCRIPT(sel, fp);
  const run = (src, els, bySel) => runInNewContext(src, fakeDom(els, bySel));

  const fp = { t: 'button', n: 'Save', r: 'button', c: hashStr('primary') };
  // los objetos vienen de otro realm de vm: se comparan campos, no deepEqual estructural
  const pick = (o) => ({ found: o.found, level: o.level, sel: o.sel });

  // exact: el selector resuelve y tag+name intactos
  const same = fakeEl({ id: 'save', className: 'primary', innerText: 'Save' });
  let out = pick(run(scriptFor('#save', fp), [same], { '#save': same }));
  assert.deepEqual(out, { found: true, level: 'exact', sel: '#save' });

  // reidentified: el selector viejo murió pero tag+name es único entre interactivos
  const moved = fakeEl({ id: 'save2', className: 'primary', innerText: 'Save' });
  const noise = fakeEl({ id: 'other', innerText: 'Cancel' });
  out = pick(run(scriptFor('#save', fp), [moved, noise], {}));
  assert.deepEqual(out, { found: true, level: 'reidentified', sel: '#save2' });

  // stable: el selector resuelve pero el nombre driftó y no hay candidato con el nombre viejo
  const renamed = fakeEl({ id: 'save', className: 'primary', innerText: 'Guardar' });
  out = pick(run(scriptFor('#save', fp), [renamed], { '#save': renamed }));
  assert.deepEqual(out, { found: true, level: 'stable', sel: '#save' });

  // gone: ni selector ni reidentificación
  out = pick(run(scriptFor('#save', fp), [noise], {}));
  assert.deepEqual(out, { found: false, level: undefined, sel: undefined });
});

test('snapshot script assigns object fingerprints to refs', async () => {
  const w = await worker();
  const out = runInNewContext(`(${w.ctx.SNAPSHOT_SCRIPT})({})`, {
    document: {
      title: 't',
      documentElement: { nodeType: 1 },
      querySelectorAll: () => [fakeEl({ innerText: 'Go' })],
      querySelector: () => null,
    },
    location: { href: 'http://x/' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    CSS: { escape: (s) => s },
  });
  const ref = out.refs['1'];
  assert.equal(ref.fp.t, 'button');
  assert.equal(ref.fp.n, 'Go');
  assert.equal(ref.fp.r, 'button');
  assert.equal(ref.fp.c, hashStr(''));
});

// corre el snapshot contra un DOM fake y devuelve {snapshot, refs}
function runSnapshot(ctx, els, opts = {}) {
  return runInNewContext(`(${ctx.SNAPSHOT_SCRIPT})(${JSON.stringify(opts)})`, {
    document: {
      title: 't',
      documentElement: { nodeType: 1 },
      querySelectorAll: () => els,
      querySelector: () => null,
    },
    location: { href: 'http://x/' },
    innerWidth: 1200, innerHeight: 800,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    CSS: { escape: (s) => s },
  });
}

test('in_viewport_only drops elements outside the viewport', async () => {
  const w = await worker();
  const onscreen = fakeEl({ innerText: 'Top' });
  const belowFold = fakeEl({
    innerText: 'Deep',
    getBoundingClientRect: () => ({ top: 5000, left: 0, right: 10, bottom: 5040 }),
  });
  const full = runSnapshot(w.ctx, [onscreen, belowFold]);
  assert.match(full.snapshot, /"Top"/);
  assert.match(full.snapshot, /"Deep"/);
  const pruned = runSnapshot(w.ctx, [onscreen, belowFold], { inViewportOnly: true });
  assert.match(pruned.snapshot, /"Top"/);
  assert.doesNotMatch(pruned.snapshot, /"Deep"/);
  assert.equal(Object.keys(pruned.refs).length, 1);
});

test('snapshot serializes compound controls inline', async () => {
  const w = await worker();
  const select = fakeEl({
    tagName: 'SELECT',
    value: 'mx',
    options: [
      { label: 'México', value: 'mx' },
      { label: 'Argentina', value: 'ar' },
    ],
  });
  const file = fakeEl({
    tagName: 'INPUT', type: 'file',
    getAttribute: (k) => (k === 'accept' ? 'image/*,.pdf' : null),
  });
  const out = runSnapshot(w.ctx, [select, file]);
  const selLine = out.snapshot.split('\n').find((l) => l.includes('combobox'));
  assert.match(selLine, /options=\["México","Argentina"\]/);
  assert.match(selLine, /options_total=2/);
  assert.match(selLine, /value="mx"/);
  const fileLine = out.snapshot.split('\n').find((l) => l.includes('type=file'));
  assert.match(fileLine, /accept="image\/\*,\.pdf"/);
});

test('snapshot options list caps at 50 and reports options_total', async () => {
  const w = await worker();
  const select = fakeEl({
    tagName: 'SELECT',
    value: 'v0',
    options: Array.from({ length: 80 }, (_, i) => ({ label: 'opt' + i, value: 'v' + i })),
  });
  const out = runSnapshot(w.ctx, [select]);
  const selLine = out.snapshot.split('\n').find((l) => l.includes('combobox'));
  assert.match(selLine, /options_total=80/);
  assert.doesNotMatch(selLine, /opt50/);
});

test('sensitive fields are redacted in snapshot and flagged in refs', async () => {
  const w = await worker();
  const pwd = fakeEl({ tagName: 'INPUT', type: 'password', name: 'pwd', value: 'hunter2', placeholder: '' });
  const cc = fakeEl({
    tagName: 'INPUT', type: 'text', name: 'card', value: '4111111111111111', placeholder: '',
    getAttribute: (k) => (k === 'autocomplete' ? 'cc-number' : null),
  });
  const ssn = fakeEl({ tagName: 'INPUT', type: 'text', name: 'user_ssn', value: '', placeholder: '' });
  const city = fakeEl({ tagName: 'INPUT', type: 'text', name: 'city', value: 'Xalapa', placeholder: '' });
  const out = runSnapshot(w.ctx, [pwd, cc, ssn, city]);
  assert.doesNotMatch(out.snapshot, /hunter2|4111111111111111/);
  assert.match(out.snapshot, /sensitive=password/);
  assert.match(out.snapshot, /sensitive=cc/);
  assert.match(out.snapshot, /sensitive=credential/);
  assert.match(out.snapshot, /value="\[redacted\]"/);
  assert.match(out.snapshot, /value="Xalapa"/);
  assert.equal(out.refs['1'].sensitive, 'password');
  assert.equal(out.refs['4'].sensitive, false);
});

test('ref check reports sensitivity of the resolved element', async () => {
  const w = await worker();
  const pwd = fakeEl({ tagName: 'INPUT', type: 'password', name: 'pwd', id: 'pwd', value: 'x', placeholder: '' });
  const fp = { t: 'input', n: '', r: 'textbox', c: hashStr('') };
  const out = runInNewContext(w.ctx.REF_CHECK_SCRIPT('#pwd', fp), fakeDom([pwd], { '#pwd': pwd }));
  assert.equal(out.level, 'exact');
  assert.equal(out.sensitive, 'password');
});

test('actions on a sensitive ref fail with human_takeover_required', async () => {
  const w = await worker();
  runInNewContext(
    'refStores.set(7, { refs: { 3: { sel: "#pwd", fp: { t: "input", n: "", r: "textbox", c: 0 }, sensitive: "password" } } })',
    w.ctx
  );
  await assert.rejects(w.ctx.resolveRef(7, 3), (e) => e.errorCode === 'human_takeover_required');
  await assert.rejects(w.ctx.resolveRef(7, 4), (e) => e.errorCode === 'stale_ref');
});

test('a policy message extends the attachment to allowlisted origins', async () => {
  const w = await worker();
  w.sockets[0].open();
  const tab = { id: 7, url: 'https://sso.example.com/login' };
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => tab;
  await assert.rejects(w.ctx.resolveTabId({ tabId: 7 }), (e) => e.errorCode === 'tab_not_attached');
  w.sockets[0].receive({ policy: { origin_allowlist: { 'https://app.example.com': ['https://sso.example.com'] } } });
  assert.equal(await w.ctx.resolveTabId({ tabId: 7 }), 7);
  tab.url = 'https://evil.example/';
  await assert.rejects(w.ctx.resolveTabId({ tabId: 7 }), (e) => e.errorCode === 'tab_not_attached');
});

test('resolveFrameSession gates OOPIF access on the attachment allowlist', async () => {
  const w = await worker();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  runInNewContext(`
    frameSessions.set(7, new Map([
      ['sess-pay', { targetId: 'frame-pay', url: 'https://payments.example.com/embed' }],
      ['sess-ads', { targetId: 'frame-ads', url: 'https://ads.example.com/x' }],
      ['sess-da', { targetId: 'fdup-a', url: 'https://dup.example.com/a' }],
      ['sess-db', { targetId: 'fdup-b', url: 'https://dup.example.com/b' }],
    ]));
    originAllowlist = { 'https://app.example.com': ['https://payments.example.com'] };
  `, w.ctx);
  // allowlisted por substring de url y por targetId exacto
  assert.equal((await w.ctx.resolveFrameSession(7, 'payments')).sessionId, 'sess-pay');
  assert.equal((await w.ctx.resolveFrameSession(7, 'frame-pay')).targetId, 'frame-pay');
  // origen no autorizado -> origin_not_allowed
  await assert.rejects(w.ctx.resolveFrameSession(7, 'ads'), (e) => e.errorCode === 'origin_not_allowed');
  // ambiguo y desconocido -> frame_not_found
  await assert.rejects(w.ctx.resolveFrameSession(7, 'dup.example.com'), (e) => e.errorCode === 'frame_not_found');
  await assert.rejects(w.ctx.resolveFrameSession(7, 'nope'), (e) => e.errorCode === 'frame_not_found');
});

test('events from a retired socket do not close the current connection', async () => {
  const w = await worker();
  const old = w.sockets[0];
  old.open();
  const delayedClose = old.onclose;
  w.listeners.message('reconnect');
  await setImmediate();
  const current = w.sockets[1];
  current.open();
  delayedClose();
  old.onerror();
  current.receive({ id: 2, tool: 'list_tabs', args: {} });
  await setImmediate();
  assert.equal(current.readyState, 1);
  assert.deepEqual(current.sent, [{ id: 2, result: { tabs: [] } }]);
  await w.fire(3000);
  assert.equal(w.sockets.length, 2);
});
