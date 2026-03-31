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

const terminalFrames = new Map();
const requestTargets = new Map();
const debuggerAttachedTabs = new Set();

bootstrap().catch((error) => {
  console.error("[browterm-background] bootstrap failed", error);
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

    if (message.type === "bt_unbind_tab") {
      clearBoundTab()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, message: String(error) }));
      return true;
    }

    if (message.type === "bt_terminal_status") {
      const tabId = sender.tab?.id;
      const frameId = normalizeFrameId(sender.frameId);
      if (typeof tabId === "number") {
        terminalFrames.set(makeTerminalFrameKey(tabId, frameId), {
          tabId,
          frameId,
          url: sender.tab?.url ?? message.url ?? "",
          title: sender.tab?.title ?? "",
          likelyTerminal: Boolean(message.likelyTerminal),
          hasTerminalSocket: Boolean(message.hasTerminalSocket),
          lastSeenAt: Date.now()
        });
        sendTerminalStatus();
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "bt_exec_event") {
      if (message.requestId && sender.tab?.id) {
        requestTargets.set(message.requestId, {
          tabId: sender.tab.id,
          frameId: normalizeFrameId(sender.frameId)
        });
      }
      if (bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
        bridgeSocket.send(JSON.stringify(message.payload));
      }
      if (isFinalExecEventType(message.payload?.type) && message.requestId) {
        requestTargets.delete(message.requestId);
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
    void handleTabRemoved(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!hasTrackedTerminalFramesForTab(tabId)) {
      return;
    }
    if (changeInfo.status === "loading") {
      removeTerminalFramesForTab(tabId);
      sendTerminalStatus();
      return;
    }
    if (changeInfo.url) {
      for (const frame of getTerminalFramesForTab(tabId)) {
        if (frame.frameId === 0) {
          frame.url = changeInfo.url;
          frame.title = tab.title ?? frame.title;
          frame.lastSeenAt = Date.now();
        }
      }
    }
  });

  chrome.action.onClicked.addListener(async (tab) => {
    if (!tab.id) {
      return;
    }

    const boundTabId = await getBoundTabId();
    if (boundTabId === tab.id) {
      await clearBoundTab();
      console.info(`[browterm-background] unbound tab ${tab.id} (${tab.url ?? ""})`);
      return;
    }

    await setBoundTab(tab.id);
    console.info(`[browterm-background] bound tab ${tab.id} (${tab.url ?? ""})`);
  });

  chrome.alarms.create("bt_keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "bt_keepalive") {
      return;
    }
    if (!bridgeSocket || bridgeSocket.readyState === WebSocket.CLOSED) {
      connectBridge().catch((error) => {
        console.warn("[browterm-background] reconnect alarm failed", error);
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
    console.warn("[browterm-background] bridge socket error", error);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge().catch((error) => {
      console.warn("[browterm-background] reconnect failed", error);
      scheduleReconnect();
    });
  }, reconnectDelayMs);

  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
}

async function handleExecRequestFromBridge(message) {
  const target = await pickTerminalTarget();
  if (!target) {
    sendBridgeMessage({
      type: "exec_error",
      requestId: message.requestId,
      message:
        "no target tab available. Keep the terminal tab open, focus it, then click the extension action to bind."
    });
    return;
  }

  requestTargets.set(message.requestId, target);

  try {
    await activateTabForInput(target.tabId);

    const response = await sendMessageWithInjection(target, {
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
      message: `failed to send command to tab ${target.tabId}: ${String(error)}`
    });
  }
}

async function handleExecCancelFromBridge(message) {
  const explicitTarget = requestTargets.get(message.requestId);
  const target = explicitTarget ?? (await pickTerminalTarget());
  if (!target) {
    sendBridgeMessage({
      type: "exec_cancelled",
      requestId: message.requestId,
      reason: "no_terminal_tab_available"
    });
    return;
  }

  try {
    await sendMessageWithInjection(target, {
      type: "bt_exec_cancel",
      requestId: message.requestId,
      reason: message.reason ?? "cancel_requested"
    });
  } catch (error) {
    sendBridgeMessage({
      type: "exec_error",
      requestId: message.requestId,
      message: `failed to cancel command in tab ${target.tabId}: ${String(error)}`
    });
  }
}

async function pickTerminalTarget() {
  const boundTabId = await getBoundTabId();
  if (typeof boundTabId !== "number") {
    return null;
  }

  const bound = await getTabById(boundTabId);
  if (!bound) {
    await clearBoundTab();
    return null;
  }

  let target = chooseBestTerminalTarget(boundTabId);
  if (target) {
    return target;
  }

  await ensureContentScriptsInjected(boundTabId, null);
  await waitForFrameStatus();
  target = chooseBestTerminalTarget(boundTabId);

  return target ?? { tabId: boundTabId, frameId: 0 };
}

async function sendTerminalStatus() {
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  const boundTabId = await getBoundTabId();
  pruneStaleTerminalFrames();

  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTabId = active[0]?.id ?? null;

  sendBridgeMessage({
    type: "terminal_status",
    terminalCount: terminalFrames.size,
    activeTabId,
    boundTabId: typeof boundTabId === "number" ? boundTabId : null,
    tabIds: [...new Set([...terminalFrames.values()].map((frame) => frame.tabId))]
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

async function sendMessageWithInjection(target, payload) {
  try {
    return await chrome.tabs.sendMessage(target.tabId, payload, buildFrameMessageOptions(target.frameId));
  } catch (error) {
    if (!isMissingReceiverError(error)) {
      throw error;
    }

    await ensureContentScriptsInjected(target.tabId, target.frameId);

    return chrome.tabs.sendMessage(target.tabId, payload, buildFrameMessageOptions(target.frameId));
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

async function handleTabRemoved(tabId) {
  removeTerminalFramesForTab(tabId);
  for (const [requestId, target] of requestTargets.entries()) {
    if (target.tabId === tabId) {
      requestTargets.delete(requestId);
    }
  }
  if (debuggerAttachedTabs.has(tabId)) {
    chrome.debugger.detach({ tabId }).catch(() => {
      // ignored
    });
    debuggerAttachedTabs.delete(tabId);
  }

  const boundTabId = await getBoundTabId();
  if (boundTabId === tabId) {
    await clearBoundTab();
    return;
  }

  sendTerminalStatus();
}

async function getBoundTabId() {
  const { boundTabId } = await chrome.storage.local.get(["boundTabId"]);
  return typeof boundTabId === "number" ? boundTabId : null;
}

async function setBoundTab(tabId) {
  const previousTabId = await getBoundTabId();
  if (typeof previousTabId === "number" && previousTabId !== tabId) {
    await clearBadge(previousTabId);
  }

  await chrome.storage.local.set({ boundTabId: tabId });
  await chrome.action.setBadgeText({ tabId, text: "BT" });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0b6bcb" });
  sendTerminalStatus();
}

async function clearBoundTab() {
  const previousTabId = await getBoundTabId();
  await chrome.storage.local.set({ boundTabId: null });
  if (typeof previousTabId === "number") {
    await clearBadge(previousTabId);
  }
  sendTerminalStatus();
}

async function clearBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
  } catch {
    // ignored
  }
}

async function activateTabForInput(tabId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    // ignored
  }
}

function normalizeFrameId(frameId) {
  return typeof frameId === "number" && frameId >= 0 ? frameId : 0;
}

function isFinalExecEventType(type) {
  return (
    type === "exec_result" ||
    type === "exec_error" ||
    type === "exec_cancelled"
  );
}

function makeTerminalFrameKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}

function hasTrackedTerminalFramesForTab(tabId) {
  for (const frame of terminalFrames.values()) {
    if (frame.tabId === tabId) {
      return true;
    }
  }
  return false;
}

function getTerminalFramesForTab(tabId) {
  const frames = [];
  for (const frame of terminalFrames.values()) {
    if (frame.tabId === tabId) {
      frames.push(frame);
    }
  }
  return frames;
}

function removeTerminalFramesForTab(tabId) {
  for (const [key, frame] of terminalFrames.entries()) {
    if (frame.tabId === tabId) {
      terminalFrames.delete(key);
    }
  }
}

function pruneStaleTerminalFrames() {
  const staleCutoff = Date.now() - 120000;
  for (const [key, frame] of terminalFrames.entries()) {
    if (frame.lastSeenAt < staleCutoff) {
      terminalFrames.delete(key);
    }
  }
}

function chooseBestTerminalTarget(tabId) {
  const now = Date.now();
  let bestFrame = null;
  let bestScore = -Infinity;

  for (const frame of getTerminalFramesForTab(tabId)) {
    let score = 0;
    if (frame.hasTerminalSocket) {
      score += 12;
    }
    if (frame.likelyTerminal) {
      score += 6;
    }
    if (frame.frameId === 0) {
      score += 1;
    }
    score += Math.max(0, 10 - Math.floor((now - frame.lastSeenAt) / 10000));

    if (score > bestScore) {
      bestScore = score;
      bestFrame = frame;
    }
  }

  if (!bestFrame) {
    return null;
  }

  return {
    tabId,
    frameId: bestFrame.frameId
  };
}

function buildFrameMessageOptions(frameId) {
  if (typeof frameId !== "number") {
    return undefined;
  }
  return { frameId };
}

async function ensureContentScriptsInjected(tabId, frameId) {
  const target =
    typeof frameId === "number"
      ? { tabId, frameIds: [frameId] }
      : { tabId, allFrames: true };

  await chrome.scripting.executeScript({
    target,
    files: ["page-hook.js"],
    world: "MAIN"
  });
  await chrome.scripting.executeScript({
    target,
    files: ["content-script.js"]
  });
}

async function waitForFrameStatus() {
  await new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
}
