export function exactOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function attachedTab(attachments, tabId, url) {
  const entry = attachments?.[String(tabId)];
  return entry && entry.origin === exactOrigin(url) ? entry : null;
}

export function mostRecentAttached(attachments, tabs) {
  return tabs
    .map((tab) => ({ tab, entry: attachedTab(attachments, tab.id, tab.url) }))
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
