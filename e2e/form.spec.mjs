import { test, expect } from './fixtures.mjs';
import { getSw } from './lib/harness.mjs';

test('form_schema enumerates fields and counts the honeypot', async ({ env, attached }) => {
  const s = await env.mcp.call('form_schema', { tabId: attached.tabId });
  const name = s.fields.find((f) => f.name === 'name');
  expect(name, 'name field missing').toBeTruthy();
  expect(name.label).toBe('Full name');
  expect(name.kind).toBe('text');
  expect(name.autocomplete).toBe('name');
  expect(s.hidden_count).toBe(1);
  const pwd = s.fields.find((f) => f.sensitive === 'password');
  expect(pwd, 'password field not flagged').toBeTruthy();
  const color = s.fields.find((f) => f.name === 'color');
  expect(color.options).toContain('blue');
});

test('apply_mapping fills a form from a stored profile', async ({ env, attached }) => {
  // same write class as the options-page pairing: the profile editor UI is out
  // of scope (AUTOFILL_SPEC), so the profile is seeded in extension storage
  const sw = await getSw(env);
  await sw.evaluate(
    `chrome.storage.local.set({profiles: {e2e: {full_name: 'Ada Lovelace', color: 'blue'}}}).then(() => 'ok')`
  );
  const keys = await env.mcp.call('list_profile_keys', { profile: 'e2e' });
  expect(keys.keys.sort()).toEqual(['color', 'full_name']);

  const s = await env.mcp.call('form_schema', { tabId: attached.tabId });
  const nameRef = s.fields.find((f) => f.name === 'name').ref;
  const colorRef = s.fields.find((f) => f.kind === 'select').ref;
  const res = await env.mcp.call('apply_mapping', {
    tabId: attached.tabId,
    profile: 'e2e',
    mapping: { [nameRef]: 'full_name', [colorRef]: 'color', 999: 'ghost_key' },
  });
  expect(res.filled).toBe(2);
  expect(res.unmapped_keys).toEqual(['ghost_key']);
  // mapping a sensitive ref reports human_takeover instead of writing
  const pwdRef = s.fields.find((f) => f.sensitive === 'password').ref;
  const res2 = await env.mcp.call('apply_mapping', {
    tabId: attached.tabId,
    profile: 'e2e',
    mapping: { [pwdRef]: 'full_name' },
  });
  expect(res2.failed[0].reason).toBe('human_takeover_required');

  const snap = JSON.stringify(await env.mcp.call('snapshot', { tabId: attached.tabId }));
  expect(snap).toContain('Ada Lovelace');
  expect(snap).toContain('blue');
});

test('press_key inserts a character into the focused input', async ({ env, attached }) => {
  const found = await env.mcp.call('find', { text: 'Full name', tabId: attached.tabId });
  const ref = Number(/\[ref=(\d+)\]/.exec(JSON.stringify(found))[1]);
  await env.mcp.call('click', { ref, tabId: attached.tabId });
  await env.mcp.call('press_key', { key: 'z', tabId: attached.tabId });
  const snap = await env.mcp.call('snapshot', { tabId: attached.tabId });
  expect(snap.snapshot ?? JSON.stringify(snap)).toContain('value="z"');
});
