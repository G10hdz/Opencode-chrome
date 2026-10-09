// Playwright fixtures: `env` is one Chrome + extension + paired bridge per
// worker; `attached` gives each test a fresh fixture tab with a seeded
// attachment (see harness.mjs header for the declared simulacrum).

import { test as base, expect } from '@playwright/test';
import { startEnv, stopEnv, startFixture, seedAttach } from './lib/harness.mjs';

export const test = base.extend({
  env: [
    async ({}, use) => {
      const env = await startEnv();
      await use(env);
      await stopEnv(env);
    },
    { scope: 'worker', timeout: 120000 },
  ],
  fixture: [
    async ({}, use) => {
      const fixture = await startFixture({
        '/': FORM_PAGE,
        '/api': (_req, res) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, marker: 'e2e-api-body' }));
        },
        '/download': (_req, res) => {
          res.setHeader('content-type', 'application/octet-stream');
          res.setHeader('content-disposition', 'attachment; filename="e2e-file.bin"');
          res.end('e2e download payload\n');
        },
      });
      await use(fixture);
      fixture.close();
    },
    { scope: 'worker' },
  ],
  attached: async ({ env, fixture }, use) => {
    const { id } = await env.mcp.call('new_tab', { url: fixture.origin });
    await seedAttach(env, id, fixture.origin);
    await use({ tabId: id, origin: fixture.origin });
  },
});

export { expect };

const FORM_PAGE = `<!doctype html><meta charset="utf-8"><title>e2e fixture</title>
<body>
<button id="go" onclick="this.innerText='clicked';document.getElementById('out').innerText='done'">go</button>
<button id="fetcher" onclick="fetch('/api').then(r=>r.json()).then(j=>{document.getElementById('out').innerText=j.marker})">call api</button>
<button id="alerter" onclick="alert('e2e alert');document.getElementById('out').innerText='alerted'">raise alert</button>
<label for="name">Full name</label>
<input id="name" name="name" placeholder="name" autocomplete="name">
<select id="color" name="color"><option>red</option><option>blue</option></select>
<input id="pw" type="password" placeholder="password">
<input id="agree" type="checkbox"><label for="agree">Agree</label>
<input id="nickname_hp" name="nickname" style="display:none" tabindex="-1">
<a href="/download" download>get file</a>
<p id="out">idle</p>
</body>`;
