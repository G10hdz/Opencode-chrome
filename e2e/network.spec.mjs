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

test('list_network filters resource types, paginates and redacts headers', async ({ env, attached }) => {
  const found = await env.mcp.call('find', { text: 'call api', tabId: attached.tabId });
  const ref = Number(/\[ref=(\d+)\]/.exec(JSON.stringify(found))?.[1]);
  await env.mcp.call('click', { ref, tabId: attached.tabId });
  await env.mcp.call('wait_for', { text: 'e2e-api-body', timeout: 5000, tabId: attached.tabId });

  const xhr = await env.mcp.call('list_network', { tabId: attached.tabId, resource_types: ['fetch', 'xhr'] });
  expect(xhr.requests.some((r) => r.url.includes('/api'))).toBe(true);
  const css = await env.mcp.call('list_network', { tabId: attached.tabId, resource_types: ['stylesheet'] });
  expect(css.requests.some((r) => r.url.includes('/api'))).toBe(false);
  expect(xhr.total).toBeGreaterThan(css.total);

  const paged = await env.mcp.call('list_network', { tabId: attached.tabId, offset: 0, limit: 1 });
  expect(paged.requests).toHaveLength(1); // total cuenta todo el buffer, no el slice
  const past = await env.mcp.call('list_network', { tabId: attached.tabId, offset: paged.total, limit: 5 });
  expect(past.requests).toHaveLength(0);
  expect(past.total).toBe(paged.total);

  const withH = await env.mcp.call('list_network', { tabId: attached.tabId, filter: '/api', include_headers: true });
  const api = withH.requests[0];
  expect(api.requestHeaders).toBeTruthy();
  for (const [k, v] of Object.entries(api.requestHeaders))
    if (['cookie', 'authorization'].includes(k.toLowerCase())) expect(v).toBe('[redacted]');
});
