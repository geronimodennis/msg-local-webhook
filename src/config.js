import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function idleMilliseconds(env) {
  if (env.IDLE_VALUE) {
    const unit = (env.IDLE_UNIT || "minutes").toLowerCase();
    const multiplier = unit === "seconds" ? 1_000 : unit === "minutes" ? 60_000 : null;
    if (multiplier) return positiveNumber(env.IDLE_VALUE, 5) * multiplier;
  }
  if (env.IDLE_SECONDS) return positiveNumber(env.IDLE_SECONDS, 300) * 1_000;
  return positiveNumber(env.IDLE_MINUTES, 5) * 60_000;
}

export function loadConfig(env = process.env) {
  const fileValues = env === process.env && existsSync(".env")
    ? parse(readFileSync(".env"))
    : {};
  const source = { ...env, ...fileValues };
  return {
    browserCdpUrl: source.BROWSER_CDP_URL || "http://127.0.0.1:9222",
    messengerUrl: source.MESSENGER_URL || "https://www.facebook.com/messages",
    dryRun: source.DRY_RUN !== "false",
    idleMs: idleMilliseconds(source),
    pollMs: positiveNumber(source.POLL_SECONDS, 15) * 1_000,
    userName: source.USER_NAME || "",
    mentionPattern: source.MENTION_PATTERN || "",
    directContacts: (source.DIRECT_CONTACTS || "").split(",").map((name) => name.trim()).filter(Boolean),
    replyPrefix: source.REPLY_PREFIX || "[DG's AI assistant]:",
    replyText: source.REPLY_TEXT || "I’m away right now and will get back to you when I can.",
    messageSelector: source.MESSAGE_SELECTOR || "[data-message-id]",
    composerSelector: source.COMPOSER_SELECTOR || 'textarea, [contenteditable="true"]'
  };
}
