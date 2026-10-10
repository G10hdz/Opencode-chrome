import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { TOOLS as BRIDGE_TOOLS } from '../src/tools.js';
import * as policy from '../extension/policy.js';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

async function worker(localStore = { token: 'test-token' }) {
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
    constructor(url) { this.url = url; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    close() { this.readyState = 3; this.onclose?.(); }
    send(data) { this.sent.push(JSON.parse(data)); }
    receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  // storage.local.get fiel a chrome.storage: undefined -> todo, array -> pick,
  // string -> {key: value}, objeto -> defaults para keys ausentes
  const pickStore = (store, key) => {
    if (key === undefined || key === null) return { ...store };
    if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => k in store).map((k) => [k, store[k]]));
    if (typeof key === 'object')
      return Object.fromEntries(Object.entries(key).map(([k, d]) => [k, k in store ? store[k] : d]));
    return key in store ? { [key]: store[key] } : {};
  };
  const chrome = {
    storage: {
      local: { get: async (key) => pickStore(localStore, key) },
      session: { get: async () => ({}) },
    },
    tabs: { query: async () => [], onRemoved: event('removed'), onUpdated: event('updated') },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: event('clicked') },
    runtime: { onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'), getManifest: () => ({ version: '0.0.0-test' }) },
    alarms: { create() {}, onAlarm: event('alarm') },
    debugger: {
      onDetach: event('detach'), onEvent: event('cdpEvent'),
      sentCommands: [],
      responses: {}, // method -> result que sendCommand devuelve por callback
      attach: (t, v, cb) => cb?.(),
      sendCommand: (t, m, p, cb) => { chrome.debugger.sentCommands.push({ target: t, method: m, params: p }); cb?.(chrome.debugger.responses[m] ?? {}); },
      detach: (t, cb) => cb?.(),
    },
    downloads: { search: async () => [] },
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

test('install and browser startup wake the worker into a connect attempt', async () => {
  for (const ev of ['installed', 'startup']) {
    const w = await worker();
    w.sockets[0].close();
    w.listeners[ev]();
    await setImmediate();
    assert.equal(w.sockets.length, 2, `${ev} should reconnect`);
  }
});

test('a stored port override drives the bridge URL', async () => {
  const w = await worker({ token: 'test-token', port: 55914 });
  assert.match(w.sockets[0].url, /127\.0\.0\.1:55914\//);
});

test('no stored port falls back to the default bridge port', async () => {
  const w = await worker();
  assert.match(w.sockets[0].url, /127\.0\.0\.1:19223\//);
});

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

test('wait_download polls chrome.downloads until a recent item completes', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/' });
  const now = new Date().toISOString();
  const item = {
    id: 9, state: 'in_progress', filename: '/tmp/x.pdf', fileSize: 4,
    mime: 'application/pdf', url: 'https://a/x.pdf', startTime: now, exists: false,
  };
  w.chrome.downloads.search = async (q) => (q.id === 9 ? [item] : [item]);
  w.sockets[0].receive({ id: 1, tool: 'wait_download', args: { tabId: 7, timeout_ms: 5000 } });
  await setImmediate();
  await setImmediate();
  assert.equal(w.sockets[0].sent.length, 0);
  item.state = 'complete';
  item.exists = true;
  await w.fire(200);
  await setImmediate();
  await setImmediate();
  assert.equal(w.sockets[0].sent[0].result.path, '/tmp/x.pdf');
  assert.equal(w.sockets[0].sent[0].result.filename, 'x.pdf');
});

test('wait_download maps an interrupted download to download_interrupted', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/' });
  const now = new Date().toISOString();
  const item = {
    id: 9, state: 'interrupted', error: 'NETWORK_FAILED', filename: '/tmp/x.pdf',
    startTime: now, endTime: now,
  };
  w.chrome.downloads.search = async () => [item];
  w.sockets[0].receive({ id: 1, tool: 'wait_download', args: { tabId: 7, timeout_ms: 5000 } });
  await setImmediate();
  await setImmediate();
  assert.equal(w.sockets[0].sent[0].error.error_code, 'download_interrupted');
});

test('run_recipe gates on the attached origin and runs steps with escaped params', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/' });
  w.ctx.toolNavigate = async () => ({ url: 'ok' });
  w.ctx.toolWaitFor = async () => ({ found: true });
  let evalExpr = null;
  w.ctx.evaluate = async (tabId, expr) => { evalExpr = expr; return [{ rank: '1', title: 'x', extra: 'drop' }]; };
  const recipe = {
    name: 'hn', origin: 'https://app.example.com',
    steps: [
      { navigate: 'https://app.example.com/' },
      { wait_for: 'ready' },
      { eval: 'search({{q}})' },
      { columns: ['rank', 'title'] },
    ],
  };
  w.sockets[0].receive({ id: 1, tool: 'run_recipe', args: { tabId: 7, recipe, params: { q: 'a"b' } } });
  await setImmediate();
  await setImmediate();
  const sent = w.sockets[0].sent[0];
  assert.equal(evalExpr, 'search("a\\"b")');
  assert.deepEqual(sent.result.output, { columns: ['rank', 'title'], rows: [{ rank: '1', title: 'x' }] });
  // origen fuera del alcance de la attachment -> origin_not_allowed
  const bad = { ...recipe, origin: 'https://evil.example.com' };
  w.sockets[0].receive({ id: 2, tool: 'run_recipe', args: { tabId: 7, recipe: bad } });
  await setImmediate();
  await setImmediate();
  assert.equal(w.sockets[0].sent[1].error.error_code, 'origin_not_allowed');
});

test('every tool the bridge exposes is registered in the extension TOOLS map', async () => {
  // name contract across the WS boundary: a drifted name fails as unknown_tool
  // only at runtime otherwise. Both sets come from executed code, not strings.
  const w = await worker();
  const registered = runInNewContext('Object.keys(TOOLS)', w.ctx);
  const missing = BRIDGE_TOOLS.filter((t) => !t.local)
    .map((t) => t.name)
    .filter((name) => !registered.includes(name));
  assert.deepEqual(missing, []);
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

// --- autofill: form_schema / apply_mapping / list_profile_keys / press_key ---

// DOM fake para FORM_SCHEMA_SCRIPT: sirve el selector de campos, lookups de
// #id (selectorFor) y getComputedStyle por elemento via __style.
const FIELD_SEL = 'input,select,textarea,[contenteditable="true"]';
function formDom(els, extra = {}) {
  return {
    document: {
      documentElement: { nodeType: 1 },
      querySelector: () => null,
      querySelectorAll: (s) => {
        if (s === FIELD_SEL) return els;
        if (s.startsWith('#')) return els.filter((e) => e.id === s.slice(1));
        return [];
      },
    },
    location: { href: 'http://x/' },
    innerWidth: 1200,
    innerHeight: 800,
    getComputedStyle: (el) => el?.__style || { display: 'block', visibility: 'visible', opacity: '1' },
    CSS: { escape: (s) => s },
    ...extra,
  };
}

test('form_schema lists labeled fields, flags sensitive and counts honeypots', async () => {
  const w = await worker();
  const fields = [
    fakeEl({
      tagName: 'INPUT', type: 'text', name: 'full_name', id: 'fn', required: true,
      labels: [{ innerText: 'Full name' }],
      getAttribute: (k) => ({ autocomplete: 'name' })[k] ?? null,
    }),
    fakeEl({
      tagName: 'SELECT', id: 'ctry', labels: [{ innerText: 'Country' }], value: 'mx',
      options: [
        { label: 'México', value: 'mx', selected: true },
        { label: 'Argentina', value: 'ar', selected: false },
      ],
      getAttribute: () => null,
    }),
    fakeEl({ tagName: 'INPUT', type: 'password', name: 'pwd', labels: [{ innerText: 'Password' }] }),
    fakeEl({ tagName: 'INPUT', type: 'checkbox', name: 'agree', checked: true, labels: [{ innerText: 'I agree' }] }),
    // honeypots: display:none y fuera de pantalla a la izquierda
    fakeEl({ tagName: 'INPUT', type: 'text', name: 'nickname_hp', __style: { display: 'none', visibility: 'visible', opacity: '1' } }),
    fakeEl({ tagName: 'INPUT', type: 'text', name: 'trap', getBoundingClientRect: () => ({ top: 0, left: -5000, right: -4900, bottom: 10 }) }),
    // ni campo ni trampa: se ignora sin contar
    fakeEl({ tagName: 'INPUT', type: 'hidden', name: 'csrf', value: 'tok' }),
  ];
  const out = runInNewContext(`(${w.ctx.FORM_SCHEMA_SCRIPT})({})`, formDom(fields));
  assert.equal(out.hidden_count, 2);
  assert.equal(out.fields.length, 4);
  const [name, country, pwd, agree] = out.fields;
  assert.deepEqual(
    { kind: name.kind, label: name.label, name: name.name, autocomplete: name.autocomplete, required: name.required },
    { kind: 'text', label: 'Full name', name: 'full_name', autocomplete: 'name', required: true }
  );
  assert.equal(country.kind, 'select');
  // viene de otro realm de vm: se comparan campos, no deepEqual estructural
  assert.equal(country.options.join('|'), 'México|Argentina');
  assert.equal(country.value, 'México');
  assert.equal(pwd.sensitive, 'password');
  assert.equal(agree.kind, 'checkbox');
  assert.equal(agree.checked, true);
  // los refs quedan registrados para fill/select/apply_mapping
  assert.equal(Object.keys(out.refs).length, 4);
  assert.equal(out.refs[name.ref].sensitive, false);
  assert.equal(out.refs[pwd.ref].sensitive, 'password');
});

test('form_schema resolves aria-label and placeholder as labels', async () => {
  const w = await worker();
  const fields = [
    fakeEl({
      tagName: 'INPUT', type: 'email', name: 'mail', id: 'm',
      getAttribute: (k) => (k === 'aria-label' ? 'Correo' : null),
    }),
    fakeEl({ tagName: 'INPUT', type: 'text', name: 'nick', id: 'n2', placeholder: 'apodo' }),
  ];
  const out = runInNewContext(`(${w.ctx.FORM_SCHEMA_SCRIPT})({})`, formDom(fields));
  assert.equal(out.fields[0].label, 'Correo');
  assert.equal(out.fields[1].label, 'apodo');
});

test('apply_mapping fills from the stored profile without leaking values', async () => {
  const w = await worker({
    token: 'test-token',
    profiles: { main: { full_name: 'Ada Lovelace', email: 'ada@x.dev' } },
  });
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/' });
  w.ctx.resolveRef = async (tabId, ref) => {
    if (ref === 2) {
      const e = new Error('sensitive');
      e.errorCode = 'human_takeover_required';
      throw e;
    }
    return { sel: '#f' + ref, level: 'exact', sessionId: undefined };
  };
  const exprs = [];
  w.ctx.evaluate = async (tabId, expr) => {
    exprs.push(expr);
    return { written: true, kind: 'text' };
  };
  w.sockets[0].receive({
    id: 1,
    tool: 'apply_mapping',
    args: { tabId: 7, profile: 'main', mapping: { 1: 'full_name', 2: 'email', 3: 'missing_key' } },
  });
  await setImmediate();
  await setImmediate();
  const res = w.sockets[0].sent[0].result;
  assert.equal(res.filled, 1);
  assert.deepEqual(res.filled_refs, [1]);
  assert.deepEqual(res.failed, [{ ref: 2, reason: 'human_takeover_required' }]);
  assert.deepEqual(res.unmapped_keys, ['missing_key']);
  // el valor se resolvió dentro de la extensión (va en el script, no en el resultado)
  assert.ok(exprs.some((e) => e.includes('Ada Lovelace')));
  assert.ok(!JSON.stringify(res).includes('Ada'));
  // perfil inexistente -> error envelope, sin tocar nada
  w.sockets[0].receive({ id: 2, tool: 'apply_mapping', args: { tabId: 7, profile: 'ghost', mapping: { 1: 'x' } } });
  await setImmediate();
  await setImmediate();
  assert.equal(w.sockets[0].sent[1].error.error_code, 'profile_not_found');
});

test('list_profile_keys returns names only, never values', async () => {
  const w = await worker({
    token: 'test-token',
    profiles: { main: { full_name: 'Ada Lovelace', email: 'ada@x.dev' } },
  });
  w.sockets[0].open();
  w.sockets[0].receive({ id: 1, tool: 'list_profile_keys', args: { profile: 'main' } });
  await setImmediate();
  await setImmediate();
  const res = w.sockets[0].sent[0].result;
  assert.deepEqual(res.keys.sort(), ['email', 'full_name']);
  assert.ok(!JSON.stringify(res).includes('ada@x.dev'));
  w.sockets[0].receive({ id: 2, tool: 'list_profile_keys', args: { profile: 'ghost' } });
  await setImmediate();
  await setImmediate();
  assert.deepEqual(w.sockets[0].sent[1].result, { keys: [] });
});

test('press_key sends keyDown/keyUp with modifier bits and validates input', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/' });
  const calls = () => w.chrome.debugger.sentCommands.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => c.params);
  w.sockets[0].receive({ id: 1, tool: 'press_key', args: { tabId: 7, key: 'Control+Enter' } });
  await setImmediate();
  await setImmediate();
  assert.equal(calls()[0].type, 'keyDown');
  assert.equal(calls()[0].key, 'Enter');
  assert.equal(calls()[0].modifiers, 2);
  assert.equal(calls()[1].type, 'keyUp');
  // caracteres imprimibles llevan text y sin modificadores
  w.chrome.debugger.sentCommands.length = 0;
  w.sockets[0].receive({ id: 2, tool: 'press_key', args: { tabId: 7, key: 'a' } });
  await setImmediate();
  await setImmediate();
  assert.equal(calls()[0].text, 'a');
  assert.equal(calls()[0].modifiers, 0);
  // modificador desconocido -> invalid_argument
  w.sockets[0].receive({ id: 3, tool: 'press_key', args: { tabId: 7, key: 'Hyper+K' } });
  await setImmediate();
  await setImmediate();
  assert.equal(w.sockets[0].sent[2].error.error_code, 'invalid_argument');
});

test('include_snapshot returns a fresh tree and replaces the ref store', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/' });
  w.ctx.resolveRef = async () => ({ sel: '#f1', level: 'exact', sessionId: undefined });
  const exprs = [];
  w.ctx.evaluate = async (tabId, expr) => {
    exprs.push(expr);
    if (expr.includes('getOwnPropertyDescriptor')) {
      return { filled: true, verified: true, actual: 'v' };
    }
    // la segunda evaluación es el snapshot post-mutación
    return { snapshot: 'page "p" "u"\n[ref=9] button "Save"', refs: { 9: { sel: '#save', fp: {} } } };
  };
  w.sockets[0].receive({ id: 1, tool: 'fill', args: { tabId: 7, ref: 1, value: 'v', include_snapshot: true } });
  await setImmediate();
  await setImmediate();
  const res = w.sockets[0].sent[0].result;
  assert.equal(res.filled, true);
  assert.match(res.snapshot, /ref=9/);
  // sin la flag no hay snapshot ni segundo evaluate
  exprs.length = 0;
  w.sockets[0].receive({ id: 2, tool: 'fill', args: { tabId: 7, ref: 1, value: 'v' } });
  await setImmediate();
  await setImmediate();
  assert.equal(w.sockets[0].sent[1].result.snapshot, undefined);
  assert.equal(exprs.length, 1);
});

test('list_console_messages collects console, exception and log events with filters', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/' });
  // la primera llamada attacha el debugger: Runtime.enable + Log.enable una vez
  w.sockets[0].receive({ id: 1, tool: 'list_console_messages', args: { tabId: 7 } });
  await setImmediate();
  await setImmediate();
  const enables = w.chrome.debugger.sentCommands.map((c) => c.method);
  assert.ok(enables.includes('Runtime.enable'));
  assert.ok(enables.includes('Log.enable'));

  const fire = (method, params) => w.listeners.cdpEvent({ tabId: 7 }, method, params);
  fire('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'boom' }], timestamp: 1 });
  fire('Runtime.exceptionThrown', { timestamp: 2, exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: x is not defined' }, url: 'https://app.example.com/a.js', lineNumber: 4 } });
  fire('Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'Failed to load /missing', url: 'https://app.example.com/missing', timestamp: 3 } });
  // eventos de tabs sin session no se registran
  w.listeners.cdpEvent({ tabId: 99 }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'ajeno' }] });

  w.sockets[0].receive({ id: 2, tool: 'list_console_messages', args: { tabId: 7 } });
  await setImmediate();
  await setImmediate();
  const { messages } = w.sockets[0].sent[1].result;
  assert.equal(messages.length, 3);
  assert.equal(
    messages.map((m) => `${m.source}:${m.type}:${m.text.slice(0, 10)}`).join('|'),
    'console:error:boom|exception:error:ReferenceE|network:error:Failed to '
  );
  // types + filter
  w.sockets[0].receive({ id: 3, tool: 'list_console_messages', args: { tabId: 7, types: ['log'] } });
  await setImmediate();
  await setImmediate();
  assert.equal(w.sockets[0].sent[2].result.messages.length, 0);
  w.sockets[0].receive({ id: 4, tool: 'list_console_messages', args: { tabId: 7, filter: 'missing' } });
  await setImmediate();
  await setImmediate();
  assert.equal(w.sockets[0].sent[3].result.messages.length, 1);
});

test('navigate action drives history and reload via CDP', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/two', status: 'complete' });
  w.chrome.debugger.responses['Page.getNavigationHistory'] = {
    currentIndex: 1,
    entries: [
      { id: 10, url: 'https://app.example.com/one' },
      { id: 11, url: 'https://app.example.com/two' },
    ],
  };
  const flush = async () => { for (let i = 0; i < 4; i++) await setImmediate(); };

  w.sockets[0].receive({ id: 1, tool: 'navigate', args: { tabId: 7, action: 'back' } });
  await flush();
  await w.fire(200); // el sleep inicial de waitForLoad
  await flush();
  const hist = w.chrome.debugger.sentCommands.find((c) => c.method === 'Page.navigateToHistoryEntry');
  assert.equal(hist.params.entryId, 10);
  assert.equal(w.sockets[0].sent[0].result.url, 'https://app.example.com/two');

  // reload + ignore_cache: Page.reload con ignoreCache y cache wrapper restaurado
  w.sockets[0].receive({ id: 2, tool: 'navigate', args: { tabId: 7, action: 'reload', ignore_cache: true } });
  await flush();
  await w.fire(200);
  await flush();
  const reload = w.chrome.debugger.sentCommands.find((c) => c.method === 'Page.reload');
  assert.equal(reload.params.ignoreCache, true);
  const cache = w.chrome.debugger.sentCommands.filter((c) => c.method === 'Network.setCacheDisabled');
  assert.deepEqual(cache.map((c) => c.params.cacheDisabled).join('|'), 'true|false');

  // validaciones: url+action juntos, action desconocida, sin historial
  w.sockets[0].receive({ id: 3, tool: 'navigate', args: { tabId: 7, url: 'https://x/', action: 'back' } });
  await flush();
  assert.equal(w.sockets[0].sent[2].error.error_code, 'invalid_argument');
  w.sockets[0].receive({ id: 4, tool: 'navigate', args: { tabId: 7, action: 'sideways' } });
  await flush();
  assert.equal(w.sockets[0].sent[3].error.error_code, 'invalid_argument');
  w.chrome.debugger.responses['Page.getNavigationHistory'] = { currentIndex: 0, entries: [{ id: 10 }] };
  w.sockets[0].receive({ id: 5, tool: 'navigate', args: { tabId: 7, action: 'back' } });
  await flush();
  assert.equal(w.sockets[0].sent[4].error.error_code, 'no_history');
});

test('navigate does not honor init_script from the model (eval lives in adapters)', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/', status: 'complete' });
  w.chrome.tabs.update = async () => {};
  const flush = async () => { for (let i = 0; i < 4; i++) await setImmediate(); };

  w.sockets[0].receive({ id: 1, tool: 'navigate', args: { tabId: 7, url: 'https://app.example.com/next', init_script: 'window.__auth=1' } });
  await flush();
  await w.fire(200);
  await flush();
  const init = w.chrome.debugger.sentCommands.find((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument');
  assert.equal(init, undefined);
});

test('run_recipe init_script registers the script and removes it after the run', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/' });
  w.ctx.toolNavigate = async () => ({ url: 'ok' });
  w.chrome.debugger.responses['Page.addScriptToEvaluateOnNewDocument'] = { identifier: 's1' };
  const recipe = {
    name: 'auth', origin: 'https://app.example.com',
    steps: [
      { init_script: 'window.__u = {{u}}' },
      { navigate: 'https://app.example.com/' },
    ],
  };
  w.sockets[0].receive({ id: 1, tool: 'run_recipe', args: { tabId: 7, recipe, params: { u: 'a"b' } } });
  await setImmediate();
  await setImmediate();
  await setImmediate();
  const add = w.chrome.debugger.sentCommands.find((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument');
  // params interpolados como literales JSON, igual que en eval
  assert.equal(add?.params?.source, 'window.__u = "a\\"b"');
  const rm = w.chrome.debugger.sentCommands.find((c) => c.method === 'Page.removeScriptToEvaluateOnNewDocument');
  assert.equal(rm?.params?.identifier, 's1');
});

test('list_network filters by resource type, paginates and redacts headers', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/' });
  const flush = async () => { for (let i = 0; i < 4; i++) await setImmediate(); };

  w.sockets[0].receive({ id: 1, tool: 'list_network', args: { tabId: 7 } }); // attacha
  await flush();
  const fire = (method, params) => w.listeners.cdpEvent({ tabId: 7 }, method, params);
  fire('Network.requestWillBeSent', { requestId: 'r1', type: 'Document', request: { method: 'GET', url: 'https://app.example.com/', headers: { Cookie: 'sid=secret', Accept: 'text/html' } }, timestamp: 1 });
  fire('Network.requestWillBeSent', { requestId: 'r2', type: 'XHR', request: { method: 'GET', url: 'https://app.example.com/api', headers: { Authorization: 'Bearer t' } }, timestamp: 2 });
  fire('Network.responseReceived', { requestId: 'r2', response: { status: 200, mimeType: 'application/json', headers: { 'Set-Cookie': 's=1', 'Content-Type': 'application/json' } }, timestamp: 3 });
  fire('Network.requestWillBeSent', { requestId: 'r3', type: 'Stylesheet', request: { method: 'GET', url: 'https://app.example.com/s.css', headers: {} }, timestamp: 4 });

  // default: sin headers en la respuesta
  w.sockets[0].receive({ id: 2, tool: 'list_network', args: { tabId: 7 } });
  await flush();
  const all = w.sockets[0].sent[1].result;
  assert.equal(all.total, 3);
  assert.equal(all.requests[0].requestHeaders, undefined);

  // resource_types + paginación
  w.sockets[0].receive({ id: 3, tool: 'list_network', args: { tabId: 7, resource_types: ['xhr', 'stylesheet'], offset: 1, limit: 1 } });
  await flush();
  const paged = w.sockets[0].sent[2].result;
  assert.equal(paged.total, 2);
  assert.equal(paged.requests.length, 1);
  assert.equal(paged.requests[0].requestId, 'r3');

  // include_headers: redactados
  w.sockets[0].receive({ id: 4, tool: 'list_network', args: { tabId: 7, include_headers: true, limit: 1 } });
  await flush();
  const withH = w.sockets[0].sent[3].result;
  assert.equal(withH.requests[0].requestHeaders.Cookie, '[redacted]');
  assert.equal(withH.requests[0].requestHeaders.Accept, 'text/html');
  w.sockets[0].receive({ id: 5, tool: 'list_network', args: { tabId: 7, include_headers: true, filter: '/api' } });
  await flush();
  const api = w.sockets[0].sent[4].result.requests[0];
  assert.equal(api.requestHeaders.Authorization, '[redacted]');
  assert.equal(api.responseHeaders['Set-Cookie'], '[redacted]');
  assert.equal(api.responseHeaders['Content-Type'], 'application/json');
});

test('list_network exports HAR over the filtered set', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/' });
  const flush = async () => { for (let i = 0; i < 4; i++) await setImmediate(); };

  w.sockets[0].receive({ id: 1, tool: 'list_network', args: { tabId: 7 } }); // attacha
  await flush();
  const fire = (method, params) => w.listeners.cdpEvent({ tabId: 7 }, method, params);
  fire('Network.requestWillBeSent', { requestId: 'r1', type: 'XHR', request: { method: 'GET', url: 'https://app.example.com/api', headers: { Authorization: 'Bearer t' } }, timestamp: 10, wallTime: 1750000000 });
  fire('Network.responseReceived', { requestId: 'r1', response: { status: 200, mimeType: 'application/json', headers: { 'Set-Cookie': 's=1' } }, timestamp: 10.2 });
  fire('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 128, timestamp: 10.3 });
  fire('Network.requestWillBeSent', { requestId: 'r2', type: 'Document', request: { method: 'GET', url: 'https://app.example.com/', headers: {} }, timestamp: 11 });

  w.sockets[0].receive({ id: 2, tool: 'list_network', args: { tabId: 7, format: 'har', filter: '/api' } });
  await flush();
  const { har, entries } = w.sockets[0].sent[1].result;
  assert.equal(entries, 1);
  const doc = JSON.parse(har);
  assert.equal(doc.log.version, '1.2');
  const e = doc.log.entries[0];
  assert.equal(e.request.url, 'https://app.example.com/api');
  assert.equal(e.startedDateTime, new Date(1750000000 * 1000).toISOString());
  assert.equal(e.time, 300);
  assert.equal(e.response.status, 200);
  assert.equal(e.request.headers.find((h) => h.name === 'Authorization').value, '[redacted]');
  assert.equal(e.response.headers.find((h) => h.name === 'Set-Cookie').value, '[redacted]');
});

test('list_storage_keys returns key names, never values', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/' });
  // la evaluate mockeada devuelve lo que el script in-page retornaría
  w.ctx.evaluate = async () => ({ local_storage: ['session_id', 'theme'], session_storage: null });
  w.sockets[0].receive({ id: 1, tool: 'list_storage_keys', args: { tabId: 7 } });
  await setImmediate();
  await setImmediate();
  await setImmediate();
  const res = w.sockets[0].sent[0].result;
  assert.equal(res.local_storage.join('|'), 'session_id|theme');
  assert.equal(res.session_storage, null);
});

test('wait_for accepts an array of alternative texts', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/' });
  w.ctx.evaluate = async () => 'Listo'; // el innerText matchea la segunda alternativa
  w.sockets[0].receive({ id: 1, tool: 'wait_for', args: { tabId: 7, text: ['Error', 'Listo'], timeout: 5000 } });
  await setImmediate();
  await setImmediate();
  const res = w.sockets[0].sent[0].result;
  assert.equal(res.found, true);
  assert.equal(res.matched, 'Listo');
  // string simple sigue devolviendo matched
  w.sockets[0].receive({ id: 2, tool: 'wait_for', args: { tabId: 7, text: 'Listo', timeout: 5000 } });
  await setImmediate();
  await setImmediate();
  assert.equal(w.sockets[0].sent[1].result.matched, 'Listo');
  // array vacío -> invalid_argument
  w.sockets[0].receive({ id: 3, tool: 'wait_for', args: { tabId: 7, text: [], timeout: 5000 } });
  await setImmediate();
  await setImmediate();
  assert.equal(w.sockets[0].sent[2].error.error_code, 'invalid_argument');
});

test('new_tab background keeps the current tab focused', async () => {
  const w = await worker();
  w.sockets[0].open();
  const created = [];
  w.chrome.tabs.create = async (o) => { created.push(o); return { id: 9, ...o }; };
  w.sockets[0].receive({ id: 1, tool: 'new_tab', args: { url: 'https://x/', background: true } });
  w.sockets[0].receive({ id: 2, tool: 'new_tab', args: { url: 'https://y/' } });
  await setImmediate();
  await setImmediate();
  assert.equal(created[0].active, false);
  assert.equal(created[1].active, true);
});

test('resize_page sets and clears device metrics override', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/' });
  w.sockets[0].receive({ id: 1, tool: 'resize_page', args: { tabId: 7, width: 390, height: 844 } });
  await setImmediate();
  await setImmediate();
  const set = w.chrome.debugger.sentCommands.find((c) => c.method === 'Emulation.setDeviceMetricsOverride');
  assert.equal(set.params.width, 390);
  assert.equal(set.params.height, 844);
  w.sockets[0].receive({ id: 2, tool: 'resize_page', args: { tabId: 7, clear: true } });
  await setImmediate();
  await setImmediate();
  assert.ok(w.chrome.debugger.sentCommands.some((c) => c.method === 'Emulation.clearDeviceMetricsOverride'));
  // sin width/height ni clear -> missing_argument
  w.sockets[0].receive({ id: 3, tool: 'resize_page', args: { tabId: 7 } });
  await setImmediate();
  await setImmediate();
  assert.equal(w.sockets[0].sent[2].error.error_code, 'missing_argument');
});

test('emulate applies environment overrides and clear resets them', async () => {
  const w = await worker();
  w.sockets[0].open();
  w.chrome.storage.session.get = async () => ({
    attachments: { 7: { origin: 'https://app.example.com', attachedAt: 1 } },
  });
  w.chrome.tabs.get = async () => ({ id: 7, url: 'https://app.example.com/' });
  const sent = (m) => w.chrome.debugger.sentCommands.filter((c) => c.method === m).map((c) => c.params);
  const flush = async () => { for (let i = 0; i < 4; i++) await setImmediate(); };

  w.sockets[0].receive({
    id: 1,
    tool: 'emulate',
    args: {
      tabId: 7,
      network: 'slow-3g',
      cpu: 4,
      color_scheme: 'dark',
      reduced_motion: true,
      geolocation: { latitude: 19.4, longitude: -99.1 },
      user_agent: 'e2e-agent',
    },
  });
  await flush();
  const res = w.sockets[0].sent[0].result;
  assert.equal(res.applied.network, 'slow-3g');
  assert.equal(sent('Network.emulateNetworkConditions')[0].latency, 400);
  assert.equal(sent('Emulation.setCPUThrottlingRate')[0].rate, 4);
  const media = sent('Emulation.setEmulatedMedia')[0].features;
  assert.equal(media.map((f) => `${f.name}=${f.value}`).join('|'), 'prefers-color-scheme=dark|prefers-reduced-motion=reduce');
  assert.equal(sent('Emulation.setGeolocationOverride')[0].latitude, 19.4);
  assert.equal(sent('Emulation.setUserAgentOverride')[0].userAgent, 'e2e-agent');

  // preset desconocido y args vacíos -> invalid_argument
  w.sockets[0].receive({ id: 2, tool: 'emulate', args: { tabId: 7, network: 'dialup' } });
  await flush();
  assert.equal(w.sockets[0].sent[1].error.error_code, 'invalid_argument');
  w.sockets[0].receive({ id: 3, tool: 'emulate', args: { tabId: 7 } });
  await flush();
  assert.equal(w.sockets[0].sent[2].error.error_code, 'invalid_argument');

  // clear:true resetea todos los overrides
  w.sockets[0].receive({ id: 4, tool: 'emulate', args: { tabId: 7, clear: true } });
  await flush();
  assert.equal(w.sockets[0].sent[3].result.cleared, true);
  assert.equal(sent('Emulation.setCPUThrottlingRate').at(-1).rate, 1);
  assert.equal(sent('Network.emulateNetworkConditions').at(-1).offline, false);
  assert.ok(w.chrome.debugger.sentCommands.some((c) => c.method === 'Emulation.clearGeolocationOverride'));
});
