import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export function createConversationCache({
  directory = ".cache",
  maxChars = 12_000,
  summarize = async (context) => context
} = {}) {
  async function fileFor(messageId) {
    await mkdir(directory, { recursive: true });
    const key = createHash("sha256").update(String(messageId)).digest("hex");
    return join(directory, `${key}.json.gz`);
  }

  async function read(messageId) {
    try {
      const compressed = await readFile(await fileFor(messageId));
      return JSON.parse((await gunzipAsync(compressed)).toString("utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        const key = createHash("sha256").update(String(messageId)).digest("hex");
        try {
          return JSON.parse(await readFile(join(directory, `${key}.json`), "utf8"));
        } catch (legacyError) {
          if (legacyError.code === "ENOENT") return { messageId, exchanges: [] };
          throw legacyError;
        }
      }
      throw error;
    }
  }

  async function update(messageId, exchanges) {
    const cache = await read(messageId);
    const known = new Set(cache.exchanges.map((exchange) => exchange.key));

    for (const exchange of exchanges) {
      const key = exchange.key || `${exchange.role}:${exchange.content}`;
      if (!exchange.content?.trim() || known.has(key)) continue;
      cache.exchanges.push({
        key,
        role: exchange.role || "conversation",
        content: exchange.content.trim(),
        timestamp: exchange.timestamp || new Date().toISOString()
      });
      known.add(key);
    }

    let context = formatExchanges(cache.exchanges);
    if (context.length > maxChars) {
      const summary = await summarize(context);
      cache.exchanges = [{
        key: `summary:${Date.now()}`,
        role: "summary",
        content: summary.trim(),
        timestamp: new Date().toISOString()
      }];
      context = formatExchanges(cache.exchanges);
    }

    cache.updatedAt = new Date().toISOString();
    cache.context = context;
    const data = Buffer.from(`${JSON.stringify(cache)}\n`, "utf8");
    await writeFile(await fileFor(messageId), await gzipAsync(data));
    return cache;
  }

  return { read, update };
}

function formatExchanges(exchanges) {
  return exchanges.map((exchange) =>
    `[${exchange.role}] ${exchange.content}`
  ).join("\n");
}
