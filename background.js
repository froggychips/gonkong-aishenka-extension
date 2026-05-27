const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";

function getGeminiText(payload) {
  return (payload.candidates || [])
    .flatMap((candidate) => ((candidate.content || {}).parts || []))
    .map((part) => part.text || "")
    .join("\n")
    .trim();
}

async function generateWithGemini({ apiKey, model, prompt }) {
  if (!apiKey) {
    throw new Error("Gemini API key is empty.");
  }
  if (!prompt) {
    throw new Error("Prompt is empty.");
  }

  const response = await fetch(
    GEMINI_ENDPOINT.replace("{model}", encodeURIComponent(model || "gemini-2.5-flash")),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.85,
          topP: 0.9,
          maxOutputTokens: 4096
        }
      })
    }
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      payload.error?.message || `Gemini request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return {
    text: getGeminiText(payload),
    raw: payload
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "AISHENKA_GEMINI_ANALYZE") {
    return false;
  }

  generateWithGemini(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
