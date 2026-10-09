export function exactOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

// allowlist: { "https://app.example.com": ["https://sso.example.com"] } — orígenes extra que
// una attachment del origen key acepta sin re-attach (SSO redirects). La empuja el bridge al
// conectar desde policy.json; vacía/undefined = solo origen exacto. Direccional: incluir B
// bajo A no habilita A bajo B.
// true si url cae en el origen de la attachment o en su allowlist. También gatea el
// acceso a frames OOPIF: un iframe embebido es la misma frontera de confianza que un
// redirect SSO.
export function originAllowed(entryOrigin, url, allowlist) {
  const origin = exactOrigin(url);
  if (!origin) return false;
  if (entryOrigin === origin) return true;
  const extra = allowlist?.[entryOrigin];
  return Array.isArray(extra) && extra.includes(origin);
}

export function attachedTab(attachments, tabId, url, allowlist) {
  const entry = attachments?.[String(tabId)];
  return entry && originAllowed(entry.origin, url, allowlist) ? entry : null;
}

export function mostRecentAttached(attachments, tabs, allowlist) {
  return tabs
    .map((tab) => ({ tab, entry: attachedTab(attachments, tab.id, tab.url, allowlist) }))
    .filter(({ entry }) => entry)
    .sort((a, b) => b.entry.attachedAt - a.entry.attachedAt)[0] || null;
}

let mutationQueue = Promise.resolve();
export function serializeMutation(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.catch(() => {});
  return run;
}

export async function pollWhileAttached({ assertAttached, check, pause, timeout, now = Date.now }) {
  const deadline = now() + timeout;
  while (true) {
    await assertAttached();
    if (await check()) return true;
    if (now() >= deadline) return false;
    await pause(500);
  }
}
