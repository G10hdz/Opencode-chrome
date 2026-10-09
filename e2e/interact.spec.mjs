import { test, expect } from './fixtures.mjs';

test('snapshot lists interactive refs on the fixture page', async ({ env, attached }) => {
  const s = await env.mcp.call('snapshot', { tabId: attached.tabId });
  const text = s.snapshot ?? JSON.stringify(s);
  expect(text).toContain('[ref=');
  expect(text).toContain('button');
  expect(text).toContain('textbox');
});

test('click produces a trusted page change', async ({ env, attached }) => {
  const found = await env.mcp.call('find', { text: 'go', tabId: attached.tabId });
  const m = /\[ref=(\d+)\]/.exec(JSON.stringify(found));
  expect(m, 'find returned no ref').toBeTruthy();
  await env.mcp.call('click', { ref: Number(m[1]), tabId: attached.tabId });
  const w = await env.mcp.call('wait_for', { text: 'clicked', timeout: 5000, tabId: attached.tabId });
  expect(w.found).toBe(true);
});

test('fill writes a visible value', async ({ env, attached }) => {
  const found = await env.mcp.call('find', { text: 'name', tabId: attached.tabId });
  const m = /\[ref=(\d+)\]/.exec(JSON.stringify(found));
  expect(m, 'find returned no ref').toBeTruthy();
  await env.mcp.call('fill', { ref: Number(m[1]), value: 'e2e-value', tabId: attached.tabId });
  const s = await env.mcp.call('snapshot', { tabId: attached.tabId });
  expect(JSON.stringify(s)).toContain('e2e-value');
});

test('select picks an option', async ({ env, attached }) => {
  const found = await env.mcp.call('find', { role: 'combobox', tabId: attached.tabId });
  const m = /\[ref=(\d+)\]/.exec(JSON.stringify(found));
  expect(m, 'find returned no ref').toBeTruthy();
  await env.mcp.call('select', { ref: Number(m[1]), option: 'blue', tabId: attached.tabId });
  const s = await env.mcp.call('snapshot', { tabId: attached.tabId });
  expect(JSON.stringify(s)).toContain('blue');
});
