const ENDPOINT = "http://127.0.0.1:3847/event";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "FORWARD_EVENT") return;
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message.payload || {}),
  })
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true;
});
