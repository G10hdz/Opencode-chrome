import { test, expect } from './fixtures.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('wait_download returns path and checksum for a real file', async ({ env, attached }) => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-e2e-dl-'));
  try {
    await env.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    const found = await env.mcp.call('find', { text: 'get file', tabId: attached.tabId });
    const m = /\[ref=(\d+)\]/.exec(JSON.stringify(found));
    expect(m, 'download link has no ref').toBeTruthy();
    const pending = env.mcp.call('wait_download', { timeout_ms: 10000, tabId: attached.tabId });
    await env.mcp.call('click', { ref: Number(m[1]), tabId: attached.tabId });
    const dl = await pending;
    expect(dl.exists).toBe(true);
    expect(dl.filename).toBe('e2e-file.bin');
    expect(dl.sha256).toBe(createHash('sha256').update('e2e download payload\n').digest('hex'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
