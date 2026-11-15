export function isIdle({ receivedAt, seenAt, now = Date.now(), idleMs }) {
  if (!Number.isFinite(receivedAt) || !Number.isFinite(idleMs)) return false;
  // A message is eligible only when it has remained unseen for the full idle period.
  const lastSeen = Number.isFinite(seenAt) ? seenAt : 0;
  return now - Math.max(receivedAt, lastSeen) >= idleMs;
}

export function shouldReply(message, { now = Date.now(), idleMs, userName, mentionPattern }) {
  if (!message || message.repliedAt) return false;
  if (!isIdle({ receivedAt: message.receivedAt, seenAt: message.seenAt, now, idleMs })) {
    return false;
  }

  if (message.isDirect === true) return true;
  if (message.isDirect === false && !message.isMention) return false;

  const text = message.text || "";
  if (message.isMention === true) return true;
  if (mentionPattern && new RegExp(mentionPattern, "iu").test(text)) return true;
  return Boolean(userName && new RegExp(`@${escapeRegExp(userName)}`, "iu").test(text));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatReply(message, prefix, body) {
  const cleanPrefix = prefix.trim();
  return `${cleanPrefix} ${body.trim()}`.trim();
}
