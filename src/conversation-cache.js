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
    try {
      const compressed = await readFile(await fileFor(messageId));
      return JSON.parse((await gunzipAsync(compressed)).toString("utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        try {
          return JSON.parse(await readFile(await fileFor(messageId, false), "utf8"));
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
    const known = new Set(cache.exchanges.map((exchange) => exchange.key));

    for (const exchange of exchanges) {
      const key = exchange.key || stableExchangeKey(exchange);
      if (!exchange.content?.trim() || known.has(key)) continue;
      cache.exchanges.push({
        key,
        role: exchange.role || "conversation",
        content: exchange.content.trim(),
        timestamp: exchange.timestamp || new Date().toISOString()
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
      context = formatExchanges([...merged.values()].sort((a, b) =>
        String(a.timestamp).localeCompare(String(b.timestamp))
      ));
    } else {
      context = formatExchanges(cache.exchanges);
    }
    if (context.length > maxChars) {
      const summary = await summarize(context);
      cache.exchanges = [{
        key: `summary:${Date.now()}`,
        role: "summary",
        content: summary.trim(),
        timestamp: new Date().toISOString()
      }];
      context = formatExchanges(cache.exchanges);
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
  return exchanges.map((exchange) =>
    `[${exchange.role}] ${exchange.content}`
  ).join("\n");
}

function stableExchangeKey(exchange) {
  return createHash("sha256")
    .update(`${exchange.role || "conversation"}|${exchange.timestamp || ""}|${exchange.content || ""}`)
    .digest("hex")
    .slice(0, 20);
}
