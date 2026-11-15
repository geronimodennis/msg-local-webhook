import test from "node:test";
import assert from "node:assert/strict";
import { isIdle, shouldReply, formatReply } from "../src/idle-policy.js";
import { loadConfig } from "../src/config.js";

test("message becomes idle after the configured interval", () => {
  assert.equal(isIdle({ receivedAt: 0, seenAt: 0, now: 300_000, idleMs: 300_000 }), true);
  assert.equal(isIdle({ receivedAt: 0, seenAt: 0, now: 299_999, idleMs: 300_000 }), false);
});

test("direct messages qualify, unrelated group messages do not", () => {
  const base = { receivedAt: 0, seenAt: 0, now: 300_000, idleMs: 300_000 };
  assert.equal(shouldReply({ ...base, isDirect: true }, base), true);
  assert.equal(shouldReply({ ...base, isDirect: false, isMention: false }, base), false);
  assert.equal(shouldReply({ ...base, isDirect: false, isMention: true }, base), true);
});

test("reply prefix is exact", () => {
  assert.equal(formatReply({ }, "[DG's AI assistant]:", "Hello"), "[DG's AI assistant]: Hello");
});

test("idle policy is configurable in seconds or minutes", () => {
  assert.equal(loadConfig({ IDLE_VALUE: "10", IDLE_UNIT: "seconds" }).idleMs, 10_000);
  assert.equal(loadConfig({ IDLE_VALUE: "2", IDLE_UNIT: "minutes" }).idleMs, 120_000);
});
