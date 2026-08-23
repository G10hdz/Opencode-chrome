import assert from "node:assert/strict";
import test from "node:test";

import {
  attachedTab,
  exactOrigin,
  mostRecentAttached,
  pollWhileAttached,
  serializeMutation,
} from "../extension/policy.js";

test("exactOrigin accepts only HTTP origins", () => {
  assert.equal(exactOrigin("https://example.com/path?q=1"), "https://example.com");
  assert.equal(exactOrigin("http://localhost:3000/a"), "http://localhost:3000");
  assert.equal(exactOrigin("chrome://settings"), null);
  assert.equal(exactOrigin("not a url"), null);
});

test("attachedTab fails closed when the origin changes", () => {
  const attachments = { 7: { origin: "https://example.com", attachedAt: 10 } };

  assert.equal(attachedTab(attachments, 7, "https://example.com/account"), attachments[7]);
  assert.equal(attachedTab(attachments, 7, "https://admin.example.com"), null);
  assert.equal(attachedTab(attachments, 8, "https://example.com"), null);
});

test("mostRecentAttached ignores stale entries", () => {
  const attachments = {
    1: { origin: "https://one.example", attachedAt: 10 },
    2: { origin: "https://two.example", attachedAt: 20 },
    3: { origin: "https://stale.example", attachedAt: 30 },
  };
  const tabs = [
    { id: 1, url: "https://one.example/a" },
    { id: 2, url: "https://two.example/b" },
    { id: 3, url: "https://other.example" },
  ];

  assert.equal(mostRecentAttached(attachments, tabs)?.tab.id, 2);
});

test("serialized attachment revocations cannot restore stale entries", async () => {
  let attachments = { 1: { origin: "https://a.test" }, 2: { origin: "https://b.test" } };
  const revoke = (tabId) => serializeMutation(async () => {
    const next = { ...attachments };
    await Promise.resolve();
    delete next[tabId];
    attachments = next;
  });

  await Promise.all([revoke(1), revoke(2)]);
  assert.deepEqual(attachments, {});
});

test("attachment mutation queue recovers after an error", async () => {
  await assert.rejects(serializeMutation(async () => {
    throw new Error("storage failed");
  }));
  await assert.doesNotReject(serializeMutation(async () => {}));
});

test("wait polling stops after attachment is revoked", async () => {
  let attached = true;
  let checks = 0;

  await assert.rejects(
    pollWhileAttached({
      assertAttached: async () => {
        if (!attached) throw new Error("tab is no longer attached or origin changed");
      },
      check: async () => {
        checks += 1;
        return false;
      },
      pause: async () => {
        attached = false;
      },
      timeout: 1000,
      now: () => 0,
    }),
    /no longer attached/
  );
  assert.equal(checks, 1);
});
