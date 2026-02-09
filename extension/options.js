const form = document.getElementById("settings-form");
const bridgeUrlInput = document.getElementById("bridge-url");
const tokenInput = document.getElementById("token");
const statusNode = document.getElementById("status");
const boundNode = document.getElementById("bound-tab");

init().catch((error) => {
  setStatus(`Failed to initialize: ${String(error)}`);
});

async function init() {
  const { bridgeUrl, token, boundTabId } = await chrome.storage.local.get([
    "bridgeUrl",
    "token",
    "boundTabId"
  ]);

  bridgeUrlInput.value = bridgeUrl || "ws://127.0.0.1:17373/extension";
  tokenInput.value = token || "";

  if (typeof boundTabId === "number") {
    try {
      const tab = await chrome.tabs.get(boundTabId);
      boundNode.textContent = `Bound tab ${boundTabId}: ${tab.url || "(URL unavailable)"}`;
    } catch {
      boundNode.textContent = `Bound tab ${boundTabId} is not currently available.`;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await chrome.storage.local.set({
      bridgeUrl: bridgeUrlInput.value.trim(),
      token: tokenInput.value
    });
    setStatus("Saved settings.");
  });
}

function setStatus(text) {
  statusNode.textContent = text;
}
