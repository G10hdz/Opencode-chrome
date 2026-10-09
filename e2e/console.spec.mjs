import { test, expect } from './fixtures.mjs';
import { getSw } from './lib/harness.mjs';

test('list_console_messages captures console calls and uncaught exceptions', async ({ env, attached }) => {
  // prime: adjunta el debugger y habilita Runtime/Log antes de emitir.
  // (Log.entryAdded hace replay de entradas recientes del browser — no asumir vacío)
  const base = await env.mcp.call('list_console_messages', { tabId: attached.tabId, filter: 'e2e-marker' });
  expect(base.messages.length).toBe(0);

  // emite por la sesión debugger de la extensión (evita el race de
  // context.pages() de Playwright con tabs creados por chrome.tabs.create)
  const sw = await getSw(env);
  await sw.evaluate(`new Promise((r) => chrome.debugger.sendCommand(
    { tabId: ${attached.tabId} },
    'Runtime.evaluate',
    { expression: "console.error('e2e-marker-console'); setTimeout(() => { throw new Error('e2e-marker-uncaught') })" },
    r
  ))`);

  // el evento viaja por el WS del debugger: poll breve por robustez
  let messages = [];
  for (let i = 0; i < 20; i++) {
    const res = await env.mcp.call('list_console_messages', { tabId: attached.tabId, filter: 'e2e-marker' });
    messages = res.messages;
    if (messages.length >= 2) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const sources = messages.map((m) => `${m.source}:${m.type}`).sort();
  expect(sources).toEqual(['console:error', 'exception:error']);
  expect(messages.find((m) => m.source === 'exception').text).toContain('e2e-marker-uncaught');
});
