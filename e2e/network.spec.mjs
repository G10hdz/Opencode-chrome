import { test, expect } from './fixtures.mjs';
import { getSw } from './lib/harness.mjs';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('list_network exports the filtered set as a HAR file', async ({ env, attached }) => {
  const found = await env.mcp.call('find', { text: 'call api', tabId: attached.tabId });
  const ref = Number(/\[ref=(\d+)\]/.exec(JSON.stringify(found))?.[1]);
  await env.mcp.call('click', { ref, tabId: attached.tabId });
  await env.mcp.call('wait_for', { text: 'e2e-api-body', timeout: 5000, tabId: attached.tabId });

  const out = join(tmpdir(), `e2e-net-${process.pid}.har`);
  try {
    const res = await env.mcp.call('list_network', { tabId: attached.tabId, filter: '/api', output_path: out });
    expect(res.path).toBe(out);
    expect(res.bytes).toBeGreaterThan(0);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    expect(doc.log.version).toBe('1.2');
    const urls = doc.log.entries.map((e) => e.request.url);
    expect(urls.some((u) => u.includes('/api'))).toBe(true);
    expect(urls.every((u) => u.includes('/api'))).toBe(true); // filter aplica al export
  } finally {
    rmSync(out, { force: true });
  }
});

test('list_storage_keys returns key names without values', async ({ env, attached }) => {
  await env.mcp.call('snapshot', { tabId: attached.tabId }); // attacha el debugger
  const sw = await getSw(env);
  await sw.evaluate(`new Promise((r) => chrome.debugger.sendCommand(
    { tabId: ${attached.tabId} },
    'Runtime.evaluate',
    { expression: 'localStorage.setItem("e2e_token","SECRET");localStorage.setItem("e2e_pref","x")', returnByValue: true },
    () => r(true)
  ))`);
  const res = await env.mcp.call('list_storage_keys', { tabId: attached.tabId });
  expect(res.local_storage).toContain('e2e_token');
  expect(res.local_storage).toContain('e2e_pref');
  expect(JSON.stringify(res)).not.toContain('SECRET');
});
