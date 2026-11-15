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
import { createConversationCache, dumpRescan } from "./conversation-cache.js";

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
      if (config.replyMode === "chatbot") {
        const chatbotLog = (message, level = "log") => {
          if (!config.chatbotVerboseLogging) return;
          logger[level](`[chatbot] ${message}`);
        };
        const previousMessages = await readConversationMessages(page, config.chatbotContextMessages);
        const scannedMessages = new Set(previousMessages);
        try {
          const cacheKey = candidate.conversationId || candidate.id;
          cache = await conversationCache.update(cacheKey, {
            threadName: candidate.threadName,
            exchanges: [
              ...previousMessages.map((content, index) => ({
                key: `context:${index}:${content}`,
                role: "conversation",
                content
              })),
              { key: `incoming:${candidate.id}`, role: "incoming", content: message.text }
            ]
          });
        } catch (error) {
          logger.error(`[watcher] conversation cache failed; using live context: ${error.message}`);
          cache = { context: previousMessages.join("\n") };
        }
        if (!config.dryRun) await showTyping(page, config.composerSelector);
        chatbotLog("is composing a message");
        try {
          replyBody = await generateReply(
            { ...message, conversationContext: cache.context },
            config,
            fetch,
            {
              rescanRequested: false,
              onEvent: (event) => {
                if (event.type === "request") chatbotLog(`request #${event.number} sent`);
                if (event.type === "response") chatbotLog(`response #${event.number}: HTTP ${event.status}`);
                if (event.type === "tool") chatbotLog(`is using tool: ${event.name}`);
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
                  chatbotLog(`request error ${event.code}`, "error");
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
                await dumpRescan(
                  config.chatbotRescanDumpDirectory,
                  candidate.id,
                  candidate.threadName,
                  scanOffset - messageCount,
                  older
                );
          await conversationCache.update(candidate.conversationId || candidate.id, {
                  threadName: candidate.threadName,
                  exchanges: older.map((content, index) => ({
                    key: `rescan:${scanOffset - messageCount}:${index}:${content}`,
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
        if (cache) {
          try {
            await conversationCache.update(candidate.id, {
              threadName: candidate.threadName,
              exchanges: [{
                key: `assistant:${currentTime}`,
                role: "assistant",
                content: text
              }]
            });
          } catch (error) {
            logger.error(`[watcher] assistant cache update failed: ${error.message}`);
          }
        }
        replied++;
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
