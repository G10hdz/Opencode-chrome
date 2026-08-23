import assert from "node:assert/strict";
import test from "node:test";

import { attachedTab, exactOrigin, mostRecentAttached } from "../extension/policy.js";

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
