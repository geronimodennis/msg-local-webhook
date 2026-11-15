export async function generateReply(message, config, fetchImpl = fetch) {
  if (!config.chatbotApiUrl) {
    throw new Error("CHATBOT_API_URL is required when REPLY_MODE=chatbot.");
  }

  const sender = message.threadName || "Messenger contact";
  const currentMessage = [
    `You are responding to the current message from ${sender}.`,
    "Reply only to this message and do not invent missing context.",
    "",
    "Current incoming message:",
    message.text
  ].join("\n");

  const response = await fetchImpl(config.chatbotApiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.chatbotApiKey ? { authorization: `Bearer ${config.chatbotApiKey}` } : {})
    },
    body: JSON.stringify({
      model: config.chatbotModel,
      messages: [
        { role: "system", content: config.chatbotSystemPrompt },
        { role: "user", content: currentMessage }
      ],
      temperature: config.chatbotTemperature
    })
  });

  if (!response.ok) {
    throw new Error(`Chatbot request failed with HTTP ${response.status}.`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Chatbot returned no reply text.");
  return content;
}
