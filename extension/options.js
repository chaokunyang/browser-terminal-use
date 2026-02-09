const form = document.getElementById("settings-form");
const bridgeUrlInput = document.getElementById("bridge-url");
const tokenInput = document.getElementById("token");
const statusNode = document.getElementById("status");
const boundNode = document.getElementById("bound-tab");
const unbindButton = document.getElementById("unbind-tab");

init().catch((error) => {
  setStatus(`Failed to initialize: ${String(error)}`);
});

async function init() {
  const { bridgeUrl, token } = await chrome.storage.local.get(["bridgeUrl", "token"]);

  bridgeUrlInput.value = bridgeUrl || "ws://127.0.0.1:17373/extension";
  tokenInput.value = token || "";
  await renderBoundStatus();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await chrome.storage.local.set({
      bridgeUrl: bridgeUrlInput.value.trim(),
      token: tokenInput.value
    });
    setStatus("Saved settings.");
  });

  unbindButton.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({ type: "bt_unbind_tab" });
    if (!response?.ok) {
      setStatus(`Failed to unbind tab: ${response?.message ?? "unknown error"}`);
      return;
    }
    await renderBoundStatus();
    setStatus("Binding cleared.");
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.boundTabId) {
      return;
    }
    void renderBoundStatus();
  });
}

function setStatus(text) {
  statusNode.textContent = text;
}

async function renderBoundStatus() {
  const { boundTabId } = await chrome.storage.local.get(["boundTabId"]);
  if (typeof boundTabId !== "number") {
    boundNode.textContent = "No tab bound.";
    unbindButton.disabled = true;
    return;
  }

  unbindButton.disabled = false;
  try {
    const tab = await chrome.tabs.get(boundTabId);
    boundNode.textContent = `Bound tab ${boundTabId}: ${tab.url || "(URL unavailable)"}`;
  } catch {
    boundNode.textContent = `Bound tab ${boundTabId} is not currently available.`;
  }
}
