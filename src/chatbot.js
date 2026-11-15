const webTools = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the public web for current information. Use this when the answer may have changed or the user asks to look something up.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "A concise web search query." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch readable text from a public HTTP or HTTPS webpage.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full HTTP or HTTPS URL to fetch." }
        },
        required: ["url"]
      }
    }
  }
];

export async function generateReply(message, config, fetchImpl = fetch) {
  if (!config.chatbotApiUrl) {
    throw new Error("CHATBOT_API_URL is required when REPLY_MODE=chatbot.");
  }

  const sender = message.threadName || "Messenger contact";
  const currentMessage = [
    `You are responding to the current message from ${sender}.`,
    "Use the previous conversation only as context. Reply only to the current message and do not invent missing context.",
    "",
    "Previous conversation context:",
    message.conversationContext || "(No previous conversation context is available.)",
    "",
    "Current incoming message:",
    message.text
  ].join("\n");

  const messages = [
    { role: "system", content: config.chatbotSystemPrompt },
    { role: "user", content: currentMessage }
  ];
  const maxCalls = config.chatbotWebAccess ? (config.chatbotWebMaxCalls || 3) : 0;
  let calls = 0;

  while (true) {
    const response = await fetchImpl(config.chatbotApiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.chatbotApiKey ? { authorization: `Bearer ${config.chatbotApiKey}` } : {})
      },
      body: JSON.stringify({
        model: config.chatbotModel,
        messages,
        temperature: config.chatbotTemperature,
        ...(config.chatbotWebAccess ? { tools: webTools } : {})
      })
    });

    if (!response.ok) {
      throw new Error(`Chatbot request failed with HTTP ${response.status}.`);
    }

    const data = await response.json();
    const assistant = data.choices?.[0]?.message;
    const toolCalls = assistant?.tool_calls || [];
    if (!toolCalls.length) {
      const content = assistant?.content?.trim();
      if (!content) throw new Error("Chatbot returned no reply text.");
      return content;
    }
    if (calls + toolCalls.length > maxCalls) {
      throw new Error("Chatbot exceeded the web-tool call limit.");
    }

    messages.push(assistant);
    for (const toolCall of toolCalls) {
      const name = toolCall.function?.name;
      let args;
      try {
        args = JSON.parse(toolCall.function?.arguments || "{}");
      } catch {
        args = {};
      }
      const result = await executeWebTool(name, args, config);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result
      });
      calls++;
    }
  }
}

async function executeWebTool(name, args, config) {
  if (name === "web_search") return searchWeb(args.query, config.chatbotWebMaxChars);
  if (name === "fetch_url") return fetchUrl(args.url, config.chatbotWebMaxChars);
  return `Unknown tool: ${name}`;
}

async function fetchUrl(value, maxChars) {
  const url = publicUrl(value);
  const response = await fetchWithTimeout(url);
  if (!response.ok) return `HTTP ${response.status} while fetching ${url}`;
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/") && !type.includes("json") && !type.includes("xml")) {
    return `Unsupported content type for ${url}: ${type}`;
  }
  const text = stripHtml(await response.text()).slice(0, maxChars);
  return `Source: ${url}\n\n${text || "(The page contained no readable text.)"}`;
}

async function searchWeb(query, maxChars) {
  if (typeof query !== "string" || !query.trim()) return "Search query is required.";
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.trim())}`;
  const response = await fetchWithTimeout(searchUrl);
  if (!response.ok) return `Search failed with HTTP ${response.status}.`;
  const html = await response.text();
  const results = [...html.matchAll(/result__a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .slice(0, 5)
    .map((match) => {
      const href = decodeURIComponent(match[1].replace(/&amp;/g, "&")).replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, "");
      return `${stripHtml(match[2])}\n${href}`;
    });
  return results.length
    ? `Search results for "${query}":\n\n${results.join("\n\n")}`.slice(0, maxChars)
    : "No search results were found.";
}

function publicUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are allowed.");
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
      /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) {
    throw new Error("Private and local network URLs are not allowed.");
  }
  return url.href;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, { signal: controller.signal, headers: { accept: "text/html,text/plain,application/json" } });
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
