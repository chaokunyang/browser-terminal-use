const PROTOCOL_VERSION = 1;
const DEFAULT_SETTINGS = {
  bridgeUrl: "ws://127.0.0.1:17373/extension",
  token: "",
  boundTabId: null
};

let bridgeSocket = null;
let reconnectTimer = null;
let reconnectDelayMs = 1500;
let statusInterval = null;

const terminalTabs = new Map();
const requestToTab = new Map();
const debuggerAttachedTabs = new Set();

bootstrap().catch((error) => {
  console.error("[bt-background] bootstrap failed", error);
});

async function bootstrap() {
  await ensureSettings();
  setupChromeEventHandlers();
  await connectBridge();
  statusInterval = setInterval(() => {
    sendTerminalStatus();
  }, 10000);
}

function setupChromeEventHandlers() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type === "bt_terminal_status") {
      const tabId = sender.tab?.id;
      if (typeof tabId === "number") {
        terminalTabs.set(tabId, {
          tabId,
          url: sender.tab?.url ?? message.url ?? "",
          title: sender.tab?.title ?? "",
          likelyTerminal: Boolean(message.likelyTerminal),
          lastSeenAt: Date.now()
        });
        sendTerminalStatus();
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "bt_exec_event") {
      if (message.requestId && sender.tab?.id) {
        requestToTab.set(message.requestId, sender.tab.id);
      }
      if (bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
        bridgeSocket.send(JSON.stringify(message.payload));
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "bt_trusted_input") {
      const tabId = sender.tab?.id;
      if (typeof tabId !== "number" || typeof message.text !== "string") {
        sendResponse({ ok: false, message: "invalid trusted input request" });
        return true;
      }

      sendTrustedInput(tabId, message.text)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, message: String(error) }));
      return true;
    }

    if (message.type === "bt_trusted_ctrl_c") {
      const tabId = sender.tab?.id;
      if (typeof tabId !== "number") {
        sendResponse({ ok: false, message: "invalid trusted ctrl-c request" });
        return true;
      }

      sendTrustedCtrlC(tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, message: String(error) }));
      return true;
    }

    if (message.type === "bt_trusted_enter") {
      const tabId = sender.tab?.id;
      if (typeof tabId !== "number") {
        sendResponse({ ok: false, message: "invalid trusted enter request" });
        return true;
      }

      sendTrustedEnter(tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, message: String(error) }));
      return true;
    }

    return false;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    terminalTabs.delete(tabId);
    if (debuggerAttachedTabs.has(tabId)) {
      chrome.debugger.detach({ tabId }).catch(() => {
        // ignored
      });
      debuggerAttachedTabs.delete(tabId);
    }
    sendTerminalStatus();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!terminalTabs.has(tabId)) {
      return;
    }
    if (changeInfo.status === "loading") {
      terminalTabs.delete(tabId);
      sendTerminalStatus();
      return;
    }
    if (changeInfo.url) {
      const current = terminalTabs.get(tabId);
      if (current) {
        current.url = changeInfo.url;
        current.title = tab.title ?? current.title;
        current.lastSeenAt = Date.now();
      }
    }
  });

  chrome.action.onClicked.addListener(async (tab) => {
    if (!tab.id) {
      return;
    }

    await chrome.storage.local.set({ boundTabId: tab.id });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "BT" });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#0b6bcb" });

    sendTerminalStatus();
    console.info(`[bt-background] bound tab ${tab.id} (${tab.url ?? ""})`);
  });

  chrome.alarms.create("bt_keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "bt_keepalive") {
      return;
    }
    if (!bridgeSocket || bridgeSocket.readyState === WebSocket.CLOSED) {
      connectBridge().catch((error) => {
        console.warn("[bt-background] reconnect alarm failed", error);
      });
    }
    sendTerminalStatus();
  });

  chrome.runtime.onSuspend.addListener(() => {
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }

    for (const tabId of debuggerAttachedTabs) {
      chrome.debugger.detach({ tabId }).catch(() => {
        // ignored
      });
    }
    debuggerAttachedTabs.clear();
  });

  chrome.debugger.onDetach.addListener((source) => {
    if (typeof source.tabId === "number") {
      debuggerAttachedTabs.delete(source.tabId);
    }
  });
}

async function ensureSettings() {
  const existing = await chrome.storage.local.get(["bridgeUrl", "token", "boundTabId"]);
  const updates = {};

  if (typeof existing.bridgeUrl !== "string") {
    updates.bridgeUrl = DEFAULT_SETTINGS.bridgeUrl;
  }

  if (typeof existing.token !== "string") {
    updates.token = DEFAULT_SETTINGS.token;
  }

  if (!(typeof existing.boundTabId === "number" || existing.boundTabId === null)) {
    updates.boundTabId = DEFAULT_SETTINGS.boundTabId;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

async function connectBridge() {
  if (bridgeSocket && (bridgeSocket.readyState === WebSocket.OPEN || bridgeSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const { bridgeUrl, token } = await chrome.storage.local.get(["bridgeUrl", "token"]);
  const url = normalizeBridgeUrl(bridgeUrl);

  bridgeSocket = new WebSocket(url);

  bridgeSocket.addEventListener("open", () => {
    reconnectDelayMs = 1500;
    const hello = {
      type: "hello",
      role: "extension",
      token: token || undefined,
      clientId: "chrome-extension",
      protocolVersion: PROTOCOL_VERSION
    };
    bridgeSocket.send(JSON.stringify(hello));
    sendTerminalStatus();
  });

  bridgeSocket.addEventListener("message", async (event) => {
    const message = safeJsonParse(event.data);
    if (!message) {
      return;
    }

    if (message.type === "ping") {
      bridgeSocket.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      return;
    }

    if (message.type === "exec_request") {
      await handleExecRequestFromBridge(message);
      return;
    }

    if (message.type === "exec_cancel") {
      await handleExecCancelFromBridge(message);
      return;
    }
  });

  bridgeSocket.addEventListener("close", () => {
    bridgeSocket = null;
    scheduleReconnect();
  });

  bridgeSocket.addEventListener("error", (error) => {
    console.warn("[bt-background] bridge socket error", error);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge().catch((error) => {
      console.warn("[bt-background] reconnect failed", error);
      scheduleReconnect();
    });
  }, reconnectDelayMs);

  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
}

async function handleExecRequestFromBridge(message) {
  const targetTabId = await pickTerminalTab();
  if (!targetTabId) {
    sendBridgeMessage({
      type: "exec_error",
      requestId: message.requestId,
      message:
        "no target tab available. Keep the terminal tab open, focus it, then click the extension action to bind."
    });
    return;
  }

  requestToTab.set(message.requestId, targetTabId);

  try {
    const response = await sendMessageWithInjection(targetTabId, {
      type: "bt_exec_request",
      requestId: message.requestId,
      command: message.command,
      timeoutMs: message.timeoutMs
    });

    if (!response?.ok) {
      sendBridgeMessage({
        type: "exec_error",
        requestId: message.requestId,
        message: response?.message ?? "tab rejected execution request"
      });
    }
  } catch (error) {
    sendBridgeMessage({
      type: "exec_error",
      requestId: message.requestId,
      message: `failed to send command to tab ${targetTabId}: ${String(error)}`
    });
  }
}

async function handleExecCancelFromBridge(message) {
  const explicitTab = requestToTab.get(message.requestId);
  const tabId = explicitTab ?? (await pickTerminalTab());
  if (!tabId) {
    sendBridgeMessage({
      type: "exec_cancelled",
      requestId: message.requestId,
      reason: "no_terminal_tab_available"
    });
    return;
  }

  try {
    await sendMessageWithInjection(tabId, {
      type: "bt_exec_cancel",
      requestId: message.requestId,
      reason: message.reason ?? "cancel_requested"
    });
  } catch (error) {
    sendBridgeMessage({
      type: "exec_error",
      requestId: message.requestId,
      message: `failed to cancel command in tab ${tabId}: ${String(error)}`
    });
  }
}

async function pickTerminalTab() {
  const { boundTabId } = await chrome.storage.local.get(["boundTabId"]);
  if (typeof boundTabId === "number") {
    const bound = await getTabById(boundTabId);
    if (bound) {
      return boundTabId;
    }
    await chrome.storage.local.set({ boundTabId: null });
  }

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof active?.id === "number") {
    return active.id;
  }

  const likely = [...terminalTabs.values()]
    .filter((entry) => entry.likelyTerminal)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  if (likely.length > 0) {
    return likely[0].tabId;
  }

  const fallback = [...terminalTabs.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return fallback.length > 0 ? fallback[0].tabId : null;
}

async function sendTerminalStatus() {
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  const { boundTabId } = await chrome.storage.local.get(["boundTabId"]);
  const staleCutoff = Date.now() - 120000;
  for (const [tabId, value] of terminalTabs.entries()) {
    if (value.lastSeenAt < staleCutoff) {
      terminalTabs.delete(tabId);
    }
  }

  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTabId = active[0]?.id ?? null;

  sendBridgeMessage({
    type: "terminal_status",
    terminalCount: terminalTabs.size,
    activeTabId,
    boundTabId: typeof boundTabId === "number" ? boundTabId : null,
    tabIds: [...terminalTabs.keys()]
  });
}

function sendBridgeMessage(payload) {
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  bridgeSocket.send(JSON.stringify(payload));
}

function normalizeBridgeUrl(raw) {
  const fallback = DEFAULT_SETTINGS.bridgeUrl;
  if (typeof raw !== "string" || raw.trim() === "") {
    return fallback;
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }

  if (trimmed.startsWith("http://")) {
    return trimmed.replace("http://", "ws://");
  }

  if (trimmed.startsWith("https://")) {
    return trimmed.replace("https://", "wss://");
  }

  return fallback;
}

function safeJsonParse(input) {
  try {
    return JSON.parse(typeof input === "string" ? input : String(input));
  } catch {
    return null;
  }
}

async function sendTrustedInput(tabId, text) {
  if (!text) {
    return;
  }

  await ensureDebuggerAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text });
}

async function sendTrustedCtrlC(tabId) {
  await ensureDebuggerAttached(tabId);

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    modifiers: 2,
    windowsVirtualKeyCode: 67,
    code: "KeyC",
    key: "c"
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 2,
    windowsVirtualKeyCode: 67,
    code: "KeyC",
    key: "c"
  });
}

async function sendTrustedEnter(tabId) {
  await ensureDebuggerAttached(tabId);

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    windowsVirtualKeyCode: 13,
    code: "Enter",
    key: "Enter"
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 13,
    code: "Enter",
    key: "Enter"
  });
}

async function ensureDebuggerAttached(tabId) {
  if (debuggerAttachedTabs.has(tabId)) {
    return;
  }

  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    debuggerAttachedTabs.add(tabId);
  } catch (error) {
    const text = String(error);
    if (text.includes("Another debugger is already attached")) {
      throw new Error("tab already has another debugger attached");
    }
    throw error;
  }
}

async function sendMessageWithInjection(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (!isMissingReceiverError(error)) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"]
    });

    return chrome.tabs.sendMessage(tabId, payload);
  }
}

function isMissingReceiverError(error) {
  const text = String(error ?? "");
  return text.includes("Receiving end does not exist");
}

async function getTabById(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}
