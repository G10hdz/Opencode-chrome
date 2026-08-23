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
