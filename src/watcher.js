import {
  inspectMessenger,
  openInboxCandidate,
  readConversationMessages,
  readInboxCandidates,
  readMessageCandidates,
  returnToInbox,
  sendReply,
  showTyping
} from "./messenger-browser.js";
import { shouldReply, formatReply } from "./idle-policy.js";
import { createStateStore } from "./state-store.js";
import { generateReply, summarizeConversation } from "./chatbot.js";
import { createConversationCache } from "./conversation-cache.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function createWatcher({
  page,
  config,
  now = () => Date.now(),
  logger = console,
  stateStore = createStateStore(),
  conversationCache = createConversationCache({
    directory: config.chatbotCacheDirectory,
    maxChars: config.chatbotCacheMaxChars,
    compression: config.chatbotCacheCompression,
    summarize: (context) => summarizeConversation(context, config)
  })
}) {
  let stopped = false;

  async function tick() {
    if (page.url().includes("/login")) {
      throw new Error("Facebook login is required before the watcher can monitor or send messages.");
    }
    const snapshot = await inspectMessenger(page);
    const inboxCandidates = await readInboxCandidates(page);
    const openCandidates = await readMessageCandidates(page, config.messageSelector);
    const candidates = inboxCandidates.length ? inboxCandidates : openCandidates;
    const currentTime = now();
    let replied = 0;
    let queued = 0;

    for (const candidate of candidates) {
      const stored = stateStore.get(candidate.id);
      const candidateReceivedAt = candidate.receivedAt || currentTime;
      const newOccurrence = Boolean(
        stored?.repliedAt &&
        candidateReceivedAt - stored.receivedAt > 90_000
      );
      const receivedAt = newOccurrence
        ? candidateReceivedAt
        : stored?.receivedAt || candidateReceivedAt;
      stateStore.set(candidate.id, { receivedAt });
      const message = {
        ...candidate,
        receivedAt,
        seenAt: candidate.unread ? (stored?.seenAt ?? undefined) : currentTime,
        isDirect: candidate.isDirect ?? config.directContacts.includes(candidate.threadName),
        isMention: matchesConfiguredMention(candidate.text, config),
        repliedAt: newOccurrence ? undefined : stored?.repliedAt
      };

      if (!shouldReply(message, {
        now: currentTime,
        idleMs: config.idleMs,
        userName: config.userName,
        mentionPattern: config.mentionPattern
      })) continue;
      queued++;

      if (inboxCandidates.length && !(await isStillUnread(page, candidate.id))) {
        logger.log(`[watcher] skipped ${candidate.id}: message is no longer unread`);
        continue;
      }

      if (inboxCandidates.length) await openInboxCandidate(page, candidate.threadName);
      let replyBody = config.replyText;
      let cache;
      const cacheKey = [candidate.conversationId, candidate.threadName]
        .filter(Boolean)
        .join("|") || candidate.id;
      if (config.replyMode === "chatbot") {
        const chatbotLog = (message, level = "log") => {
          if (!config.chatbotVerboseLogging) return;
          logger[level](`[chatbot] ${message}`);
        };
        const previousMessages = await readConversationMessages(page, config.chatbotContextMessages);
        const scannedMessages = new Set(previousMessages);
        try {
          const conversationMessages = [...previousMessages];
          if (!conversationMessages.some((content) => content.includes(message.text))) {
            conversationMessages.push(message.text);
          }
          cache = await conversationCache.update(cacheKey, {
            threadName: candidate.threadName,
            exchanges: [
              ...conversationMessages
                .slice(-config.chatbotContextMessages)
                .map((content) => ({
                  key: exchangeKey("context", content),
                  role: "conversation",
                  content
                }))
            ]
          });
        } catch (error) {
          logger.error(`[watcher] conversation cache failed; using live context: ${error.message}`);
          cache = { context: previousMessages.join("\n") };
        }
        if (!config.dryRun) await showTyping(page, config.composerSelector);
        chatbotLog("is composing a message");
        try {
          chatbotLog(`historical context: ${cache.context?.length || 0} characters`);
          replyBody = await generateReply(
            {
              ...message,
              conversationContext: cache.context
            },
            config,
            fetch,
            {
              rescanRequested: false,
              onEvent: (event) => {
                if (event.type === "request") {
                  chatbotLog(
                    `request #${event.number} sent: model=${event.model}; ` +
                    `messages=${event.messageCount}; images=${event.imageCount}; ` +
                    `tool_choice=${JSON.stringify(event.toolChoice)}`
                  );
                }
                if (event.type === "response") chatbotLog(`response #${event.number}: HTTP ${event.status}`);
                if (event.type === "response_detail") {
                  chatbotLog(
                    `response #${event.number} detail: ` +
                    `tool_calls=${event.toolCalls.length ? event.toolCalls.join(", ") : "none"}; ` +
                    `reply=${event.replyCharacters} characters`
                  );
                }
                if (event.type === "context") {
                  chatbotLog(
                    `model=${event.model}; prompt=${event.characters} characters; ` +
                    `vision=${event.vision ? "attached" : "none"}; ` +
                    `tools=${event.tools.length ? event.tools.join(", ") : "none"}`
                  );
                }
                if (event.type === "reply") chatbotLog(`reply generated: ${event.characters} characters`);
                if (event.type === "tool") chatbotLog(`is using tool: ${event.name}`);
                if (event.type === "tool_args") {
                  chatbotLog(`tool parameters ${event.name}: ${JSON.stringify(event.args)}`);
                }
                if (event.type === "tool_image") {
                  chatbotLog(
                    `tool image ${event.name}: ${event.url}` +
                    (event.source ? `; source=${event.source}` : "") +
                    (event.sourceUrl ? `; source_url=${event.sourceUrl}` : "") +
                    (event.path ? `; dumped to ${event.path}` : "")
                  );
                }
                if (event.type === "tool_result") {
                  const size = event.messageCount
                    ? `${event.messageCount} messages`
                    : `${event.characters} characters`;
                  chatbotLog(`tool result: ${event.name} (${size})`);
                }
                if (event.type === "retry") {
                  chatbotLog(`retrying after ${event.toolCount} tool call(s)`);
                }
                if (event.type === "error") {
                  chatbotLog(`request error ${event.code}: ${event.message || "unknown error"}`, "error");
                }
              },
              rescanConversation: async (messageCount, offset) => {
                let older = [];
                let scanOffset = offset;
                for (let attempt = 0; attempt < 4 && !older.length; attempt++) {
                  const pageMessages = await readConversationMessages(page, messageCount, scanOffset);
                  older = pageMessages.filter((content) => !scannedMessages.has(content));
                  scanOffset += messageCount;
                }
                for (const content of older) scannedMessages.add(content);
                await conversationCache.update(cacheKey, {
                  threadName: candidate.threadName,
                  exchanges: older.map((content) => ({
                    key: exchangeKey("rescan", content),
                    role: "conversation",
                    content
                  }))
                });
                return {
                  messageCount: older.length,
                  content: older.length
                    ? `Older conversation messages around offset ${scanOffset - messageCount} (${older.length} messages):\n${older.join("\n")}`
                    : "No additional older conversation messages were found after scanning deeper."
                };
              },
              captureConversation: async () => {
                return captureConversationImage(page, config.chatbotVisionDumpDirectory);
              }
            }
          );
          chatbotLog("composed a response");
        } catch (error) {
          chatbotLog(
            `error ${error.code || "UNKNOWN"}: ${error.message}; using fallback reply`,
            "error"
          );
          replyBody = config.chatbotFallbackText;
        }
      }
      const text = formatReply(message, config.replyPrefix, replyBody);
      if (config.dryRun) {
        logger.log(`[watcher] DRY RUN candidate ${candidate.id}: ${text}`);
      } else {
        await sendReply(page, text, config.composerSelector);
        stateStore.markReplied(candidate.id, currentTime);
        replied++;
      }
      // Dry-run does not send to Messenger, but it must still retain the
      // generated reply so the next chatbot turn has conversational memory.
      // Live mode reaches this point only after Messenger confirms the send.
      if (cache) {
        try {
          await conversationCache.update(cacheKey, {
            threadName: candidate.threadName,
            exchanges: [{
              key: exchangeKey("assistant", text, candidate.id),
              role: "assistant",
              content: text
            }]
          });
        } catch (error) {
          logger.error(`[watcher] assistant cache update failed: ${error.message}`);
        }
      }
    }
    await stateStore.save();
    if (replied > 0) await returnToInbox(page, config.messengerUrl);

    logger.log(
      `[watcher] ${new Date().toISOString()} ${snapshot.url} ` +
      `messages=${candidates.length} queued=${queued} replied=${replied} dryRun=${config.dryRun}`
    );
    return { snapshot, candidates, replied };
  }

  async function start() {
    await stateStore.load();
    logger.log(`[watcher] monitoring every ${config.pollMs / 1000}s; idle=${config.idleMs / 60000}m`);
    while (!stopped) {
      try {
        await tick();
      } catch (error) {
        logger.error(`[watcher] ${error.code || "ERROR"}: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    }
  }

  function stop() {
    stopped = true;
  }

  return { start, stop, tick, sendReply };
}

async function isStillUnread(page, messageId) {
  const candidates = await readInboxCandidates(page);
  return candidates.some((candidate) => candidate.id === messageId && candidate.unread);
}

function matchesConfiguredMention(text, config) {
  if (!text) return false;
  if (config.mentionPattern) {
    try {
      return new RegExp(config.mentionPattern, "iu").test(text);
    } catch {
      return false;
    }
  }
  return Boolean(
    config.userName &&
    new RegExp(`@${escapeRegExp(config.userName)}`, "iu").test(text)
  );
}

function exchangeKey(role, content, suffix = "") {
  const digest = createHash("sha256")
    .update(`${role}|${suffix}|${String(content).trim()}`)
    .digest("hex")
    .slice(0, 20);
  return `${role}:${digest}`;
}

async function captureConversationImage(page, dumpDirectory = "") {
  await scrollConversationRecent(page);
  const imageLocator = page.locator('[role="main"] img');
  const imageIndex = await imageLocator.evaluateAll((images) => {
    const candidates = images.map((image, index) => {
      const rect = image.getBoundingClientRect();
      const visible = rect.width > 120 &&
        rect.height > 120 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
      return { index, area: rect.width * rect.height, bottom: rect.bottom, visible };
    }).filter((candidate) => candidate.visible);
    candidates.sort((a, b) => b.bottom - a.bottom || b.area - a.area);
    return candidates[0]?.index ?? -1;
  }).catch(() => -1);
  const target = imageIndex >= 0
    ? imageLocator.nth(imageIndex)
    : page.locator('[role="main"]').first();
  let image;
  let imageMime = "image/png";
  let sourceUrl = "";
  let source = "conversation view";
  if (imageIndex >= 0) {
    sourceUrl = await target.evaluate((element) => element.currentSrc || element.src || "");
    try {
      const response = await page.context().request.get(sourceUrl);
      if (response.ok()) {
        image = await response.body();
        imageMime = response.headers()["content-type"]?.split(";")[0] || imageMime;
        source = "Messenger original image";
      }
    } catch {
      // Some Messenger URLs are blob URLs or require page-only credentials.
    }
  }
  if (!image) image = await target.screenshot({ type: "png" });
  let path;
  if (dumpDirectory) {
    await mkdir(dumpDirectory, { recursive: true });
    const extension = imageMime === "image/jpeg"
      ? "jpg"
      : imageMime === "image/webp"
        ? "webp"
        : imageMime === "image/gif"
          ? "gif"
          : "png";
    path = join(dumpDirectory, `vision-${Date.now()}.${extension}`);
    await writeFile(path, image);
  }
  return {
    imageUrl: `data:${imageMime};base64,${image.toString("base64")}`,
    path,
    source,
    sourceUrl
  };
}

async function scrollConversationRecent(page) {
  const moved = await page.evaluate(() => {
    const main = document.querySelector('[role="main"]');
    const message = main?.querySelector('[aria-label*="Message sent" i], [aria-label*="Message received" i]');
    const ancestors = [];
    for (let element = message; element; element = element.parentElement) ancestors.push(element);
    const scrollables = [...ancestors, main, ...main?.querySelectorAll("*") || []]
      .filter((element) => {
        if (!element || element.scrollHeight <= element.clientHeight + 20) return false;
        const rect = element.getBoundingClientRect();
        return element.clientHeight > 100 && rect.width > 300;
      })
      .sort((a, b) =>
        (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
      );
    const scrollable = scrollables[0];
    if (!scrollable) return false;
    const oldTop = scrollable.scrollTop;
    scrollable.scrollTop = scrollable.scrollHeight;
    scrollable.dispatchEvent(new Event("scroll", { bubbles: true }));
    return oldTop !== scrollable.scrollTop;
  }).catch(() => false);
  if (moved) await page.waitForTimeout(750);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
