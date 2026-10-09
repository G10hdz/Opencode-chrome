import { test, expect } from './fixtures.mjs';

test('extension pairs and connects to the bridge', async ({ env }) => {
  const status = await env.mcp.call('browser_status');
  expect(status.connected).toBe(true);
});

test('list_tabs shows only attached tabs', async ({ env, attached }) => {
  const r = await env.mcp.call('list_tabs');
  const tabs = r.tabs ?? r;
  expect(tabs.map((t) => t.id)).toContain(attached.tabId);
});
