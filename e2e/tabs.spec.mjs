import { test, expect } from './fixtures.mjs';
import { seedAttach } from './lib/harness.mjs';

test('attach, activate and close across two tabs', async ({ env, fixture, attached }) => {
  const second = await env.mcp.call('new_tab', { url: fixture.origin + '/api' });
  await seedAttach(env, second.id, fixture.origin);

  const tabs = (await env.mcp.call('list_tabs')).tabs;
  expect(tabs.map((t) => t.id)).toEqual(
    expect.arrayContaining([attached.tabId, second.id])
  );

  await env.mcp.call('activate_tab', { id: attached.tabId });
  await env.mcp.call('close_tab', { id: second.id });
  const after = (await env.mcp.call('list_tabs')).tabs;
  expect(after.map((t) => t.id)).toContain(attached.tabId);
  expect(after.map((t) => t.id)).not.toContain(second.id);
});
