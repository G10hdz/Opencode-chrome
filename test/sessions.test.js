import assert from "node:assert/strict";
import test from "node:test";
import * as bridge from "../src/sessions.js";
import * as extension from "../extension/session-config.js";

test("session parsers stay in step and fail closed", () => {
  const samples = [undefined, null, 0, 1, 2, 10, 11, 1.5, "4", "4abc", "", true];
  for (const value of samples) {
    assert.equal(bridge.clampSessions(value), extension.clampSessions(value));
    assert.equal(bridge.clampPort(value), extension.clampPort(value));
  }
  assert.equal(bridge.clampSessions(undefined), 1);
  assert.equal(bridge.clampSessions(11), 10);
  assert.equal(bridge.clampPort("19223"), 19223);
  assert.equal(bridge.clampPort("12abc"), null);
  assert.deepEqual(bridge.parseSessionConfig(null), { sessions: 1, port: 19223 });
  assert.deepEqual(bridge.parseSessionConfig({ sessions: 4 }), { sessions: 4, port: 19223 });
  assert.deepEqual(bridge.parseSessionConfig({ sessions: 99, port: 19230 }), {
    sessions: 10,
    port: 19230,
  });
  assert.deepEqual(bridge.sessionPorts(19223, 3), [19223, 19224, 19225]);
  assert.deepEqual(extension.sessionPorts(65535, 3), [65535]);
});
