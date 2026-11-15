import { chromium } from "playwright";

export async function connectMessenger(config) {
  const browser = await chromium.connectOverCDP(config.browserCdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No browser context found.");

  const pages = context.pages();
  let page = pages.find((candidate) =>
    candidate.url().includes("facebook.com/messages")
  );
  page ||= pages.find((candidate) =>
    candidate.url().includes("facebook.com") &&
    !candidate.url().includes("/login")
  );
  if (!page) page = await context.newPage();
  if (!page.url().includes("facebook.com/messages")) {
    await page.goto(config.messengerUrl, { waitUntil: "domcontentloaded" });
  }
  if (page.url().includes("/login")) {
    throw new Error("Facebook is not logged in in the remote-debugging browser.");
  }
  return { browser, page, userName: await detectUserName(page) };
}

export async function detectUserName(page) {
  const accountButton = page.getByLabel("Account, your profile");
  if (!(await accountButton.count())) return "";
  await accountButton.click();
  try {
    const dialog = page.locator('[role="dialog"]').last();
    const lines = (await dialog.innerText()).split("\n").map((line) => line.trim()).filter(Boolean);
    return lines[0] || "";
  } finally {
    await page.keyboard.press("Escape");
  }
}

export async function inspectMessenger(page) {
  return page.evaluate(() => {
    const main = document.querySelector('[role="main"]') || document.body;
    const text = main.innerText || "";
    const inputs = [...main.querySelectorAll('textarea, [contenteditable="true"]')];
    return {
      title: document.title,
      url: location.href,
      text: text.slice(-4000),
      composerCount: inputs.length
    };
  });
}

export async function readMessageCandidates(page, selector) {
  return page.evaluate((messageSelector) => {
    const conversationId = location.pathname.match(/\/messages\/t\/([^/]+)/)?.[1] || "";
    return [...document.querySelectorAll(messageSelector)].map((element, index) => {
      const container = element.closest('[role="main"]') || element;
      const label = element.getAttribute("aria-label") || "";
      const time = element.querySelector("time")?.dateTime || element.querySelector("time")?.textContent || "";
      return {
        id: element.getAttribute("data-message-id") || `${index}:${element.textContent}`,
        conversationId,
        text: (element.innerText || element.textContent || "").trim(),
        label,
        time,
        hasMention: /(^|\s)@\S+/u.test(element.textContent || ""),
        isDirect: element.closest('[data-thread-type="direct"]')
          ? true
          : element.closest('[data-thread-type="group"]')
            ? false
            : null,
        unread: /unread|unseen|new message/iu.test(`${label} ${container.getAttribute("aria-label") || ""}`)
      };
    }).filter((message) => message.text);
  }, selector);
}

export async function readInboxCandidates(page) {
  return page.evaluate(() => {
    function parseAge(value) {
      const match = value.match(/(\d+)\s*([smhd])/iu);
      if (!match) return 0;
      const multipliers = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
      return Number(match[1]) * multipliers[match[2].toLowerCase()];
    }

    const markers = [...document.querySelectorAll("*")].filter(
      (element) => element.childElementCount === 0 && element.textContent?.trim() === "Unread message:"
    );
    const seen = new Set();
    const candidates = [];

    for (const marker of markers) {
      const card = marker.parentElement?.parentElement?.parentElement;
      if (!card || seen.has(card)) continue;
      seen.add(card);
      const lines = (card.innerText || "").split("\n").map((line) => line.trim()).filter(Boolean);
      const markerIndex = lines.indexOf("Unread message:");
      const threadName = lines[0];
      const preview = lines[markerIndex + 1] || "";
      const age = lines.find((line) => /^(now|\d+\s*[smhd])$/iu.test(line)) || "now";
      if (!threadName || !preview) continue;
      candidates.push({
        id: `${threadName}|${preview}`,
        conversationId: card.closest("a")?.href.match(/\/messages\/t\/([^/?]+)/)?.[1] || "",
        threadName,
        text: preview,
        age,
        receivedAt: Date.now() - parseAge(age),
        hasMention: /(^|\s)@\S+/u.test(preview),
        unread: true
      });
    }
    return candidates;
  });
}

export async function openInboxCandidate(page, threadName) {
  await page.getByText(threadName, { exact: true }).first().click();
  await page.waitForTimeout(500);
}

export async function returnToInbox(page, messengerUrl) {
  const inboxUrl = `${messengerUrl.replace(/\/+$/, "")}/t/`;
  const chatsLink = page.locator('a[href$="/messages/t/"]').first();
  if (await chatsLink.count()) {
    await chatsLink.click();
    await page.waitForTimeout(500);
  }
  if (!page.url().replace(/\/+$/, "").endsWith("/messages/t")) {
    await page.goto(inboxUrl, { waitUntil: "domcontentloaded" });
  }
}

export async function sendReply(page, text, selector) {
  const composer = page.locator(selector).last();
  await composer.waitFor({ state: "visible", timeout: 5_000 });
  const existingSentReplies = await countSentReplies(page, text);
  await composer.fill(text);
  await composer.press("Enter");
  try {
    await page.waitForFunction(
      ({ replyText, existingCount }) => {
        const sentCount = [...document.querySelectorAll('[aria-label*="Message sent" i]')]
          .filter((node) => {
            const label = node.getAttribute("aria-label") || "";
            return /\bby you\b/iu.test(label) && label.includes(replyText);
          }).length;
        return sentCount > existingCount;
      },
      { replyText: text, existingCount: existingSentReplies },
      { timeout: 0 }
    );
  } catch (error) {
    error.code = "SEND_RECEIPT_ERROR";
    throw error;
  }
  await page.waitForTimeout(500);
}

export async function showTyping(page, selector) {
  const composer = page.locator(selector).last();
  await composer.waitFor({ state: "visible", timeout: 5_000 });
  await composer.fill("…");
}

export async function readConversationContext(page, messageCount = 10) {
  return (await readConversationMessages(page, messageCount))
    .join("\n");
}

export async function readConversationMessages(page, messageCount = 10, offset = 0) {
  const targetCount = Math.max(1, Number(messageCount) || 1);
  const collected = new Set();
  const attempts = offset > 0 ? 1 : 6;
  for (let attempt = 0; attempt < attempts && collected.size < targetCount; attempt++) {
    if (attempt > 0 || offset > 0) await scrollConversationOlder(page);
    const messages = await page.locator('[role="main"]').evaluate((main) => {
    const seen = new Set();
    const labelled = [...main.querySelectorAll('[aria-label*="Message sent" i], [aria-label*="Message received" i]')]
      .map((node) => (node.getAttribute("aria-label") || "").trim());
    const visible = labelled.length
      ? labelled
      : [...main.querySelectorAll("*")].map((node) => (node.innerText || "").trim());
    return visible
      .filter((text) => /message (sent|received)/iu.test(text) && text.length < 2_000)
      .filter((text) => {
        if (seen.has(text)) return false;
        seen.add(text);
        return true;
      });
    }).catch(() => []);
    for (const message of messages) collected.add(message);
    if (!messages.length) break;
  }

  if (collected.size) {
    const messages = [...collected];
    if (offset > 0) return messages.slice(0, targetCount);
    return messages.slice(-targetCount);
  }
  const fallback = (await page.locator('[role="main"]').innerText().catch(() => "")).trim();
  return fallback ? [fallback] : [];
}

async function scrollConversationOlder(page) {
  const before = await page.evaluate(() => {
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
    if (!scrollable) return null;
    const oldTop = scrollable.scrollTop;
    scrollable.scrollTop = Math.max(0, oldTop - Math.max(400, scrollable.clientHeight * 0.85));
    scrollable.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { oldTop, newTop: scrollable.scrollTop };
  });
  if (!before) return;
  await page.waitForTimeout(750);
}

async function countSentReplies(page, text) {
  return page.evaluate((replyText) => [...document.querySelectorAll('[aria-label*="Message sent" i]')]
    .filter((node) => {
      const label = node.getAttribute("aria-label") || "";
      return /\bby you\b/iu.test(label) && label.includes(replyText);
    }).length, text);
}
