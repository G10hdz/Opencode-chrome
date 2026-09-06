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
    debugger: { onDetach: event('detach') },
  };
  runInNewContext(source.replace(/^import .*;\n/, ''), {
    ...policy, chrome, WebSocket: Socket,
    setTimeout(fn, ms) { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  });
  await setImmediate();
  return {
    sockets, chrome, listeners, timers,
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
