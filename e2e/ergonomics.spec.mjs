import { test, expect } from './fixtures.mjs';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('fill with include_snapshot returns the fresh tree in the same call', async ({ env, attached }) => {
  const found = await env.mcp.call('find', { text: 'Full name', tabId: attached.tabId });
  const ref = Number(/\[ref=(\d+)\]/.exec(JSON.stringify(found))[1]);
  const res = await env.mcp.call('fill', {
    ref, value: 'Ada', include_snapshot: true, tabId: attached.tabId,
  });
  expect(res.filled).toBe(true);
  // el snapshot post-mutación ya trae el valor y refs nuevos
  expect(res.snapshot).toContain('value="Ada"');
  expect(res.snapshot).toContain('[ref=');
});

test('output_path writes snapshot and screenshot payloads to files', async ({ env, attached }) => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-e2e-'));

  const snapPath = join(dir, 'snap.txt');
  const res = await env.mcp.call('snapshot', { tabId: attached.tabId, output_path: snapPath });
  expect(res.path).toBe(snapPath);
  expect(res.snapshot).toBeUndefined();
  const tree = readFileSync(snapPath, 'utf8');
  expect(tree).toContain('Full name');
  expect(res.bytes).toBe(Buffer.byteLength(tree));

  const pngPath = join(dir, 'shot.png');
  const shot = await env.mcp.call('screenshot', { tabId: attached.tabId, output_path: pngPath });
  expect(shot.path).toBe(pngPath);
  expect(existsSync(pngPath)).toBe(true);
  // PNG magic bytes: el bridge decodificó el base64
  expect(readFileSync(pngPath).subarray(0, 4).toString('hex')).toBe('89504e47');
});
