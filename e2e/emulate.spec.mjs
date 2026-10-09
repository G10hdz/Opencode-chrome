import { test, expect } from './fixtures.mjs';
import { getSw } from './lib/harness.mjs';

// Runtime.evaluate al page target por la sesión debugger de la extensión
async function pageEval(env, tabId, expression) {
  const sw = await getSw(env);
  return sw.evaluate(`new Promise((r) => chrome.debugger.sendCommand(
    { tabId: ${tabId} },
    'Runtime.evaluate',
    { expression: ${JSON.stringify(expression)}, returnByValue: true, awaitPromise: true },
    (res) => r(res && res.result && res.result.value)
  ))`);
}

test('emulate color_scheme flips matchMedia in the page', async ({ env, attached }) => {
  // emulate attacha el debugger; pageEval usa esa misma sesión.
  // No se asume el default del sistema (puede ser dark nativamente).
  const dark = `matchMedia('(prefers-color-scheme: dark)').matches`;
  const light = `matchMedia('(prefers-color-scheme: light)').matches`;
  await env.mcp.call('emulate', { color_scheme: 'dark', tabId: attached.tabId });
  expect(await pageEval(env, attached.tabId, dark)).toBe(true);
  expect(await pageEval(env, attached.tabId, light)).toBe(false);
  await env.mcp.call('emulate', { color_scheme: 'light', tabId: attached.tabId });
  expect(await pageEval(env, attached.tabId, light)).toBe(true);
  expect(await pageEval(env, attached.tabId, dark)).toBe(false);
  await env.mcp.call('emulate', { clear: true, tabId: attached.tabId });
});

test('emulate offline makes fetches fail until cleared', async ({ env, attached }) => {
  const probe = `fetch('/api').then(() => 'ok').catch(() => 'fail')`;
  await env.mcp.call('snapshot', { tabId: attached.tabId }); // attacha el debugger
  expect(await pageEval(env, attached.tabId, probe)).toBe('ok');
  await env.mcp.call('emulate', { network: 'offline', tabId: attached.tabId });
  expect(await pageEval(env, attached.tabId, probe)).toBe('fail');
  await env.mcp.call('emulate', { clear: true, tabId: attached.tabId });
  expect(await pageEval(env, attached.tabId, probe)).toBe('ok');
});
