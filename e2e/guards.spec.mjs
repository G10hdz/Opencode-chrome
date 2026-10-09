import { test, expect } from './fixtures.mjs';
import { startFixture } from './lib/harness.mjs';

test('password fields are redacted and refuse ref actions', async ({ env, attached }) => {
  const s = await env.mcp.call('snapshot', { tabId: attached.tabId });
  const text = JSON.stringify(s);
  expect(text).toContain('sensitive=password');
  const found = await env.mcp.call('find', { text: 'password', tabId: attached.tabId });
  const m = /\[ref=(\d+)\]/.exec(JSON.stringify(found));
  expect(m, 'password field has no ref').toBeTruthy();
  await expect(
    env.mcp.call('click', { ref: Number(m[1]), tabId: attached.tabId })
  ).rejects.toThrow(/human_takeover_required/);
});

test('cross-origin navigation detaches the tab', async ({ env, attached }) => {
  const other = await startFixture({ '/': '<title>other origin</title><p>elsewhere</p>' });
  try {
    await env.mcp.call('navigate', { url: other.origin, tabId: attached.tabId });
    await expect(env.mcp.call('snapshot', { tabId: attached.tabId })).rejects.toThrow(
      /origin_changed|tab_not_attached/
    );
  } finally {
    other.close();
  }
});
