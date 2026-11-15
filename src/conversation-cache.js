import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export function createConversationCache({
  directory = ".cache",
  maxChars = 12_000,
  compression = true,
  summarize = async (context) => context
} = {}) {
  async function fileFor(messageId, compressed = compression) {
    await mkdir(directory, { recursive: true });
    const key = createHash("sha256").update(String(messageId)).digest("hex");
    return join(directory, `${key}.json${compressed ? ".gz" : ""}`);
  }

  async function read(messageId) {
    const preferred = await fileFor(messageId, compression);
    try {
      return await readCacheFile(preferred, compression);
    } catch (error) {
      if (error.code === "ENOENT") {
        const alternate = await fileFor(messageId, !compression);
        try {
          return await readCacheFile(alternate, !compression);
        } catch (legacyError) {
          if (legacyError.code === "ENOENT") return { messageId, exchanges: [] };
          throw legacyError;
        }
      }
      throw error;
    }
  }

  async function update(messageId, input) {
    const { threadName = "", exchanges = input } = Array.isArray(input)
      ? { exchanges: input }
      : input;
    const cache = await read(messageId);
    cache.threadName ||= threadName;
    cache.memory ||= { summary: "" };
    cache.exchanges = cache.exchanges.map((exchange) => ({
      ...exchange,
      timestamp: messageTimestamp(exchange.content, exchange.timestamp)
    }));
    const known = new Set(cache.exchanges.map((exchange) => exchange.key));

    for (const exchange of exchanges) {
      const key = exchange.key || stableExchangeKey(exchange);
      if (!exchange.content?.trim() || known.has(key)) continue;
      cache.exchanges.push({
        key,
        role: exchange.role || "conversation",
        content: exchange.content.trim(),
        timestamp: messageTimestamp(exchange.content, exchange.timestamp)
      });
      known.add(key);
    }

    let context;
    if (threadName) {
      const merged = new Map();
      for (const entry of await readThread(threadName)) {
        for (const exchange of entry.cache.exchanges) merged.set(exchange.key, exchange);
      }
      for (const exchange of cache.exchanges) merged.set(exchange.key, exchange);
        context = formatContext(cache.memory, [...merged.values()].sort(compareExchanges));
      } else {
      context = formatContext(cache.memory, cache.exchanges);
    }
    if (context.length > maxChars) {
      const summary = await summarize(context);
      cache.memory.summary = summary.trim();
      cache.exchanges = [{
        key: `summary:${Date.now()}`,
        role: "summary",
        content: cache.memory.summary,
        timestamp: new Date().toISOString()
      }];
      context = formatContext(cache.memory, cache.exchanges);
      cache.context = context;
      cache.threadName = threadName;
      await writeCache(messageId, cache);
      await removeDuplicateThreadCaches(messageId, threadName);
      return cache;
    }

    cache.updatedAt = new Date().toISOString();
    cache.context = context;
    await writeCache(messageId, cache);
    await removeDuplicateThreadCaches(messageId, threadName);
    return cache;
  }

  async function removeDuplicateThreadCaches(messageId, threadName) {
    if (!threadName) return;
    const currentPath = await fileFor(messageId, compression);
    for (const entry of await readThread(threadName)) {
      if (entry.path !== currentPath) await unlink(entry.path).catch(() => {});
    }
  }

  async function readThread(threadName) {
    await mkdir(directory, { recursive: true });
    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".json.gz") || file.endsWith(".json"));
    const entries = [];
    for (const file of files) {
      const path = join(directory, file);
      try {
        const cache = file.endsWith(".gz")
          ? JSON.parse((await gunzipAsync(await readFile(path))).toString("utf8"))
          : JSON.parse(await readFile(path, "utf8"));
        if (cache.threadName === threadName || cache.messageId?.startsWith(`${threadName}|`)) {
          entries.push({ path, cache });
        }
      } catch {
        // Ignore incomplete or unrelated cache files.
      }
    }
    return entries;
  }

  async function writeCache(messageId, cache) {
    const target = await fileFor(messageId, compression);
    const data = Buffer.from(`${JSON.stringify(cache)}\n`, "utf8");
    await writeFile(target, compression ? await gzipAsync(data) : data);
    const key = createHash("sha256").update(String(messageId)).digest("hex");
    await unlink(join(directory, `${key}.${compression ? "json" : "json.gz"}`)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  return { read, update, readThread };
}

async function readCacheFile(path, compressed) {
  const data = await readFile(path);
  return JSON.parse(
    (compressed ? await gunzipAsync(data) : data).toString("utf8")
  );
}

export async function dumpRescan(directory, messageId, threadName, offset, messages) {
  await mkdir(directory, { recursive: true });
  const key = createHash("sha256").update(String(messageId)).digest("hex");
  const file = join(directory, `${key}-offset-${offset}.txt`);
  const content = [
    `Thread: ${threadName || "(unknown)"}`,
    `Message ID: ${messageId}`,
    `Range: ${offset + 1}-${offset + messages.length}`,
    `Scanned: ${new Date().toISOString()}`,
    "",
    messages.join("\n\n")
  ].join("\n");
  await writeFile(file, `${content}\n`, "utf8");
  return file;
}

function formatExchanges(exchanges) {
  return exchanges.map((exchange) => {
    const role = exchange.role === "conversation"
      ? (/\bby\s+You\s*:/iu.test(exchange.content) ? "assistant" : "user")
      : exchange.role;
    return `[${role}] ${exchange.content}`;
  }).join("\n");
}

function formatContext(memory, exchanges) {
  const sections = [];
  if (memory?.summary?.trim()) {
    sections.push(`[persistent memory]\n${memory.summary.trim()}`);
  }
  if (exchanges.length) sections.push(formatExchanges(exchanges));
  return sections.join("\n\n");
}

function stableExchangeKey(exchange) {
  return createHash("sha256")
    .update(`${exchange.role || "conversation"}|${exchange.timestamp || ""}|${exchange.content || ""}`)
    .digest("hex")
    .slice(0, 20);
}

function messageTimestamp(content, fallback) {
  const match = String(content || "").match(
    /Message\s+(?:sent|received)\s+(\d{1,2}):(\d{2})\s*([AP]M)/iu
  );
  if (!match) return fallback || new Date().toISOString();

  const date = new Date();
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === "PM") hour += 12;
  date.setHours(hour, Number(match[2]), 0, 0);
  return date.toISOString();
}

function compareExchanges(a, b) {
  const timestampDifference = String(a.timestamp).localeCompare(String(b.timestamp));
  if (timestampDifference) return timestampDifference;
  return messageTimestamp(a.content, "").localeCompare(messageTimestamp(b.content, ""));
}
