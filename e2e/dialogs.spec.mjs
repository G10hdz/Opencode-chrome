import { test, expect } from './fixtures.mjs';

// The extension auto-answers dialogs with the tab's policy (default accept)
// the moment Page.javascriptDialogOpening arrives, so `pending` is ephemeral;
// `recent` is the durable record. Drive the default policy first, then a
// dismiss, and assert both recorded outcomes.
test('dialog policy routes a real alert through handle_dialog', async ({ env, attached }) => {
  const found = await env.mcp.call('find', { text: 'raise alert', tabId: attached.tabId });
  const m = /\[ref=(\d+)\]/.exec(JSON.stringify(found));
  expect(m, 'alert button has no ref').toBeTruthy();
  const ref = Number(m[1]);

  async function handledVerdict(verdict) {
    for (let i = 0; i < 40; i++) {
      const d = await env.mcp.call('list_dialogs', { tabId: attached.tabId }).catch(() => null);
      const e = d?.recent?.find((r) => r.message === 'e2e alert' && r.handled === verdict);
      if (e) return e;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  await env.mcp.call('click', { ref, tabId: attached.tabId });
  const accepted = await handledVerdict('accept');
  expect(accepted, 'default-policy alert never recorded').toBeTruthy();

  await env.mcp.call('handle_dialog', { action: 'dismiss', tabId: attached.tabId });
  await env.mcp.call('click', { ref, tabId: attached.tabId });
  const dismissed = await handledVerdict('dismiss');
  expect(dismissed, 'dismiss-policy alert never recorded').toBeTruthy();
});
