import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIdle, shouldReply, formatReply } from "../src/idle-policy.js";
import { loadConfig } from "../src/config.js";
import { createConversationCache } from "../src/conversation-cache.js";

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

test("model metadata controls chatbot capabilities and tools", () => {
  const config = loadConfig({ CHATBOT_MODEL: "qwen3.5:9b" });
  assert.equal(config.chatbotVision, true);
  assert.equal(config.chatbotWebAccess, true);
  assert.equal(loadConfig({ CHATBOT_MODEL: "unknown-model" }).chatbotVision, false);
});

test("conversation cache retains twenty distinct context messages with compact keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "msg-local-webhook-cache-"));
  try {
    const cache = createConversationCache({
      directory,
      compression: false,
      maxChars: 100_000
    });
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: "conversation",
      content: `Message ${index + 1}`,
      timestamp: new Date(1_000 + index).toISOString()
    }));

    const result = await cache.update("conversation-1|Test contact", {
      threadName: "Test contact",
      exchanges: messages
    });

    assert.equal(result.exchanges.length, 20);
    assert.equal(result.context.split("\n").length, 20);
    assert.ok(result.exchanges.every((exchange) => !exchange.key.includes(exchange.content)));
    assert.ok(result.exchanges.every((exchange) => exchange.key.length < 40));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("conversation cache preserves earlier turns for the next reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "msg-local-webhook-memory-"));
  try {
    const cache = createConversationCache({
      directory,
      compression: false,
      maxChars: 100_000
    });
    await cache.update("conversation-2|Test contact", {
      threadName: "Test contact",
      exchanges: [
        { key: "message-1", role: "conversation", content: "My favorite color is blue." },
        { key: "reply-1", role: "assistant", content: "I’ll remember that your favorite color is blue." }
      ]
    });
    const next = await cache.update("conversation-2|Test contact", {
      threadName: "Test contact",
      exchanges: [
        { key: "message-2", role: "conversation", content: "What color do I like?" }
      ]
    });

    assert.match(next.context, /favorite color is blue/);
    assert.match(next.context, /What color do I like/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("conversation cache orders Messenger messages by their displayed time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "msg-local-webhook-order-"));
  try {
    const cache = createConversationCache({
      directory,
      compression: false,
      maxChars: 100_000
    });
    const result = await cache.update("conversation-3|Test contact", {
      threadName: "Test contact",
      exchanges: [
        { key: "later", role: "conversation", content: "Enter, Message sent 11:41 PM by Me: Current question" },
        { key: "earlier", role: "conversation", content: "Enter, Message sent 11:28 PM by Me: Can you tell me about Gundam 00?" }
      ]
    });

    assert.ok(result.context.indexOf("Gundam 00") < result.context.indexOf("Current question"));
    assert.match(result.context, /\[user\].*Gundam 00/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("conversation cache keeps persistent memory after compaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "msg-local-webhook-summary-"));
  try {
    const cache = createConversationCache({
      directory,
      compression: false,
      maxChars: 50,
      summarize: async () => "The user prefers Gundam 00 and asked about Setsuna."
    });
    const compacted = await cache.update("conversation-4|Test contact", {
      threadName: "Test contact",
      exchanges: [
        { key: "one", role: "conversation", content: "My favorite is Gundam 00." },
        { key: "two", role: "conversation", content: "Tell me about Setsuna F. Seiei." }
      ]
    });
    const next = await cache.update("conversation-4|Test contact", {
      threadName: "Test contact",
      exchanges: [
        { key: "three", role: "conversation", content: "What do you remember?" }
      ]
    });

    assert.match(compacted.memory.summary, /Gundam 00/);
    assert.match(next.context, /persistent memory/);
    assert.match(next.context, /Gundam 00/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
