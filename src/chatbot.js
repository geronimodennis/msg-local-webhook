export async function generateReply(message, config, fetchImpl = fetch) {
  if (!config.chatbotApiUrl) {
    throw new Error("CHATBOT_API_URL is required when REPLY_MODE=chatbot.");
  }

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
        { role: "user", content: message.text }
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
