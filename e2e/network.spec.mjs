import { test, expect } from './fixtures.mjs';

test('list_network sees a real fetch and get_network_body returns it', async ({ env, attached }) => {
  const found = await env.mcp.call('find', { text: 'call api', tabId: attached.tabId });
  const m = /\[ref=(\d+)\]/.exec(JSON.stringify(found));
  expect(m, 'api button has no ref').toBeTruthy();
  await env.mcp.call('click', { ref: Number(m[1]), tabId: attached.tabId });
  await env.mcp.call('wait_for', { text: 'e2e-api-body', timeout: 5000, tabId: attached.tabId });

  const net = await env.mcp.call('list_network', { tabId: attached.tabId, filter: '/api' });
  const requests = net.requests ?? net;
  const api = requests.find((r) => r.url?.includes('/api'));
  expect(api, 'no /api request captured').toBeTruthy();

  const body = await env.mcp.call('get_network_body', { requestId: api.requestId, tabId: attached.tabId });
  expect(JSON.stringify(body)).toContain('e2e-api-body');
});
