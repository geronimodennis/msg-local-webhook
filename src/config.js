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

function chatbotEndpoint(value) {
  const url = (value || "").replace(/\/+$/, "");
  if (url.endsWith("/chat/completions")) return url;
  if (url.endsWith("/v1")) return `${url}/chat/completions`;
  return url;
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
    replyMode: source.REPLY_MODE === "chatbot" ? "chatbot" : "static",
    chatbotFallbackText: source.CHATBOT_FALLBACK_TEXT ||
      source.REPLY_TEXT ||
      "I’m away right now and will get back to you when I can.",
    chatbotApiUrl: chatbotEndpoint(source.CHATBOT_API_URL),
    chatbotApiKey: source.CHATBOT_API_KEY || "",
    chatbotModel: source.CHATBOT_MODEL || "default",
    chatbotVerboseLogging: source.CHATBOT_VERBOSE_LOGGING !== "false",
    chatbotTemperature: Number.isFinite(Number(source.CHATBOT_TEMPERATURE))
      ? Number(source.CHATBOT_TEMPERATURE)
      : 0.4,
    chatbotWebAccess: source.CHATBOT_WEB_ACCESS === "true",
    chatbotWebMaxChars: positiveNumber(source.CHATBOT_WEB_MAX_CHARS, 8_000),
    chatbotWebMaxCalls: Math.min(5, positiveNumber(source.CHATBOT_WEB_MAX_CALLS, 3)),
    chatbotContextMessages: Math.floor(positiveNumber(source.CHATBOT_CONTEXT_MESSAGES, 1)),
    chatbotCacheDirectory: source.CHATBOT_CACHE_DIRECTORY || ".cache",
    chatbotCacheMaxChars: positiveNumber(source.CHATBOT_CACHE_MAX_CHARS, 12_000),
    chatbotSystemPrompt: source.CHATBOT_SYSTEM_PROMPT ||
      "Reply concisely and helpfully as a personal Messenger assistant. Do not claim to be human. Use natural conversational text. Emojis and normal Messenger formatting are allowed, but do not use Markdown syntax, Markdown headings, Markdown bullets, code blocks, or Markdown links.",
    messageSelector: source.MESSAGE_SELECTOR || "[data-message-id]",
    composerSelector: source.COMPOSER_SELECTOR || 'textarea, [contenteditable="true"]'
  };
}
