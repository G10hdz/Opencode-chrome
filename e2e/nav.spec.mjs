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
