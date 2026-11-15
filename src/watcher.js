import {
  inspectMessenger,
  openInboxCandidate,
  readInboxCandidates,
  readMessageCandidates,
  returnToInbox,
  sendReply
} from "./messenger-browser.js";
import { shouldReply, formatReply } from "./idle-policy.js";
import { createStateStore } from "./state-store.js";
import { generateReply } from "./chatbot.js";

export function createWatcher({
  page,
  config,
  now = () => Date.now(),
  logger = console,
  stateStore = createStateStore()
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

      if (inboxCandidates.length) await openInboxCandidate(page, candidate.threadName);
      let replyBody = config.replyText;
      if (config.replyMode === "chatbot") {
        try {
          replyBody = await generateReply(message, config);
        } catch (error) {
          logger.error(`[watcher] chatbot reply skipped: ${error.message}`);
          continue;
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
    }
    await stateStore.save();
    if (replied > 0) await returnToInbox(page, config.messengerUrl);

    logger.log(
      `[watcher] ${new Date().toISOString()} ${snapshot.url} ` +
      `messages=${candidates.length} replied=${replied} dryRun=${config.dryRun}`
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
        logger.error(`[watcher] ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    }
  }

  function stop() {
    stopped = true;
  }

  return { start, stop, tick, sendReply };
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
