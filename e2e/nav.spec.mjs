import { test, expect } from './fixtures.mjs';
import { getSw } from './lib/harness.mjs';

test('navigate action back/forward/reload round-trips history', async ({ env, fixture, attached }) => {
  // el fixture sirve '/' por pathname: la query da una segunda entry en el mismo origen
  await env.mcp.call('navigate', { url: `${fixture.origin}/?nav=2`, tabId: attached.tabId });
  const back = await env.mcp.call('navigate', { action: 'back', tabId: attached.tabId });
  expect(back.url).toBe(`${fixture.origin}/`);
  const fwd = await env.mcp.call('navigate', { action: 'forward', tabId: attached.tabId });
  expect(fwd.url).toBe(`${fixture.origin}/?nav=2`);
  const rel = await env.mcp.call('navigate', { action: 'reload', ignore_cache: true, tabId: attached.tabId });
  expect(rel.url).toBe(`${fixture.origin}/?nav=2`);
});

test('navigate init_script runs on the new document', async ({ env, fixture, attached }) => {
  await env.mcp.call('navigate', {
    url: `${fixture.origin}/?init=1`,
    init_script: 'window.__e2eInit = 42',
    tabId: attached.tabId,
  });
  // leo por la sesión debugger de la extensión (mismo canal que las tools)
  const sw = await getSw(env);
  const val = await sw.evaluate(`new Promise((r) => chrome.debugger.sendCommand(
    { tabId: ${attached.tabId} },
    'Runtime.evaluate',
    { expression: 'window.__e2eInit', returnByValue: true },
    (res) => r(res && res.result && res.result.value)
  ))`);
  expect(val).toBe(42);
});

test('navigate handle_before_unload auto-answers the dialog per tab policy', async ({ env, fixture, attached }) => {
  // beforeunload necesita sticky activation: un click CDP real la provee
  const found = await env.mcp.call('find', { text: 'call api', tabId: attached.tabId });
  const ref = Number(/\[ref=(\d+)\]/.exec(JSON.stringify(found))?.[1]);
  await env.mcp.call('click', { ref, tabId: attached.tabId });
  const sw = await getSw(env);
  await sw.evaluate(`new Promise((r) => chrome.debugger.sendCommand(
    { tabId: ${attached.tabId} },
    'Runtime.evaluate',
    { expression: 'window.onbeforeunload = () => "x"', returnByValue: true },
    (res) => r(res && res.result)
  ))`);
  const res = await env.mcp.call('navigate', {
    url: `${fixture.origin}/?bunload=1`,
    handle_before_unload: true,
    tabId: attached.tabId,
  });
  // la nav completa: un beforeunload sin responder bloquearía hasta timeout.
  // (los dialog stores se resetean por nav en onUpdated, igual que net/console)
  expect(res.url).toBe(`${fixture.origin}/?bunload=1`);
});

test('navigate back with no history errors with no_history', async ({ env, attached }) => {
  // el tab del fixture solo tiene una entry
  await expect(
    env.mcp.call('navigate', { action: 'back', tabId: attached.tabId })
  ).rejects.toThrow(/no_history|no back entry/);
});

test('wait_for resolves the first matching alternative', async ({ env, attached }) => {
  const res = await env.mcp.call('wait_for', {
    text: ['texto-que-no-existe', 'Full name'],
    timeout: 5000,
    tabId: attached.tabId,
  });
  expect(res.found).toBe(true);
  expect(res.matched).toBe('Full name');
});

test('resize_page applies a viewport override to the page', async ({ env, attached }) => {
  await env.mcp.call('resize_page', { width: 390, height: 844, tabId: attached.tabId });
  // leo innerWidth por la sesión debugger de la extensión (mismo canal que las tools)
  const sw = await getSw(env);
  const width = await sw.evaluate(`new Promise((r) => chrome.debugger.sendCommand(
    { tabId: ${attached.tabId} },
    'Runtime.evaluate',
    { expression: 'innerWidth', returnByValue: true },
    (res) => r(res && res.result && res.result.value)
  ))`);
  expect(width).toBe(390);
  await env.mcp.call('resize_page', { clear: true, tabId: attached.tabId });
});
