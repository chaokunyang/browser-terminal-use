const STATUS_INTERVAL_MS = 5000;
const COMMAND_TIMEOUT_FALLBACK_MS = 120000;
const START_CONFIRM_TIMEOUT_MS = 1500;
const EXTENSION_CONTEXT_INVALIDATED_PATTERNS = [
  "Extension context invalidated",
  "Extension context was invalidated",
  "Could not establish connection. Receiving end does not exist"
];

let activeExecution = null;
let pageRequestCounter = 0;
let statusTimer = null;
let domObserver = null;
let domFlushTimer = null;
let domBuffer = "";
let runtimeAvailable = true;
const pageRequests = new Map();

setupMessageBridges();
setupRuntimeHandlers();
startStatusHeartbeat();

class MarkerParser {
  constructor(markers) {
    this.markers = markers;
    this.state = "awaiting_start";
    this.buffer = "";
    this.output = "";
    this.exitCode = null;
  }

  feed(chunk) {
    if (this.state === "done") {
      return this.snapshot([]);
    }

    this.buffer += chunk;
    const emitted = [];

    this.maybeTransitionToCapturing();

    while (this.state === "capturing") {
      const endIdx = this.buffer.indexOf(this.markers.end);
      if (endIdx >= 0) {
        this.emitCleaned(this.buffer.slice(0, endIdx), emitted);
        this.buffer = this.buffer.slice(endIdx + this.markers.end.length);
        this.state = "done";
        break;
      }

      const hold = this.holdbackLength();
      if (this.buffer.length <= hold) {
        break;
      }

      const emitLen = this.buffer.length - hold;
      this.emitCleaned(this.buffer.slice(0, emitLen), emitted);
      this.buffer = this.buffer.slice(emitLen);
    }

    return this.snapshot(emitted);
  }

  maybeTransitionToCapturing() {
    if (this.state !== "awaiting_start") {
      return;
    }

    const startIdx = findStartMarkerIndex(this.buffer, this.markers.start);
    if (startIdx < 0) {
      this.buffer = keepPotentialStartPrefix(this.buffer, this.markers.start);
      return;
    }

    this.buffer = trimSingleLeadingNewline(this.buffer.slice(startIdx + this.markers.start.length));
    this.state = "capturing";
  }

  emitCleaned(text, emitted) {
    if (text.length === 0) {
      return;
    }
    const cleaned = this.stripRcMarker(text);
    if (cleaned.length > 0) {
      emitted.push(cleaned);
      this.output += cleaned;
    }
  }

  stripRcMarker(text) {
    const escaped = this.markers.rcPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`${escaped}(-?\\d+)`, "g");
    return text.replace(regex, (_full, rcText) => {
      const parsed = Number.parseInt(rcText, 10);
      if (!Number.isNaN(parsed)) {
        this.exitCode = parsed;
      }
      return "";
    });
  }

  holdbackLength() {
    return Math.max(this.markers.end.length, this.markers.rcPrefix.length + 16, 32);
  }

  snapshot(chunks) {
    return {
      chunks,
      started: this.state !== "awaiting_start",
      completed: this.state === "done",
      exitCode: this.exitCode
    };
  }
}

function setupRuntimeHandlers() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type === "bt_exec_request") {
      handleExecRequest(message)
        .then((res) => sendResponse(res))
        .catch((error) => sendResponse({ ok: false, message: String(error) }));
      return true;
    }

    if (message.type === "bt_exec_cancel") {
      cancelExecution(message.requestId, message.reason ?? "cancel_requested")
        .then((res) => sendResponse(res))
        .catch((error) => sendResponse({ ok: false, message: String(error) }));
      return true;
    }

    return false;
  });
}

function setupMessageBridges() {
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || typeof event.data !== "object") {
      return;
    }

    const message = event.data;

    if (message.source === "bt-page-hook" && message.type === "bt-page-hook-response") {
      const pending = pageRequests.get(message.requestId);
      if (!pending) {
        return;
      }
      pageRequests.delete(message.requestId);
      if (message.ok) {
        pending.resolve(message.payload);
      } else {
        pending.reject(new Error(message.error || "page hook request failed"));
      }
      return;
    }

    if (message.source === "bt-page-hook" && message.type === "bt-page-hook-output") {
      if (typeof message.chunk !== "string" || message.chunk.length === 0) {
        return;
      }
      handleExecutionChunk("ws", message.chunk);
      return;
    }

    if (message.source === "bt-page-hook" && message.type === "bt-page-hook-status") {
      sendStatus(isLikelyTerminalPage() || Boolean(message.hasTerminalSocket), Boolean(message.hasTerminalSocket));
    }
  });
}

function startStatusHeartbeat() {
  sendStatus(isLikelyTerminalPage(), false);
  statusTimer = setInterval(async () => {
    const hook = await sendPageRequest("status", {}, 800).catch(() => null);
    const hasTerminalSocket = Boolean(hook?.hasTerminalSocket);
    const likely = isLikelyTerminalPage() || hasTerminalSocket;
    sendStatus(likely, hasTerminalSocket);
  }, STATUS_INTERVAL_MS);
}

function sendStatus(likelyTerminal, hasTerminalSocket) {
  void sendRuntimeMessageSafe({
    type: "bt_terminal_status",
    likelyTerminal,
    hasTerminalSocket,
    url: window.location.href
  });
}

async function handleExecRequest(message) {
  if (!message.requestId || typeof message.command !== "string") {
    return { ok: false, message: "bad request" };
  }

  if (activeExecution) {
    return { ok: false, message: `already running request ${activeExecution.requestId}` };
  }

  const markers = buildMarkers(message.requestId);
  const wrappedCommand = buildWrappedCommand(message.command, markers);

  const parserBySource = {
    ws: new MarkerParser(markers),
    dom: new MarkerParser(markers)
  };

  activeExecution = {
    requestId: message.requestId,
    markers,
    parserBySource,
    source: null,
    output: "",
    startedAt: Date.now(),
    timeoutMs: normalizeTimeout(message.timeoutMs),
    timeoutTimer: null,
    domFallbackTimer: null,
    startWaiters: []
  };

  activeExecution.timeoutTimer = setTimeout(() => {
    cancelExecution(message.requestId, "timeout").catch((error) => {
      emitExecEvent("exec_error", {
        requestId: message.requestId,
        message: `timeout cancel failed: ${String(error)}`
      });
      cleanupExecution();
    });
  }, activeExecution.timeoutMs);

  // Start DOM capture immediately so fast commands cannot emit markers before fallback begins.
  startDomObserver();

  const sent = await sendInputToTerminal(wrappedCommand);
  if (!sent) {
    emitExecEvent("exec_error", {
      requestId: message.requestId,
      message: "failed to deliver command to terminal after marker confirmation retries"
    });
    cleanupExecution();
    return { ok: false, message: "command injection failed" };
  }

  emitExecEvent("exec_started", {
    requestId: message.requestId,
    startedAt: Date.now()
  });

  return { ok: true };
}

async function cancelExecution(requestId, reason) {
  if (!activeExecution || activeExecution.requestId !== requestId) {
    return { ok: true };
  }

  await sendControlC();
  emitExecEvent("exec_cancelled", {
    requestId,
    reason
  });
  cleanupExecution();
  return { ok: true };
}

function handleExecutionChunk(source, chunk) {
  if (!activeExecution) {
    return;
  }

  const rawChunk = typeof chunk === "string" ? chunk : String(chunk ?? "");
  if (!rawChunk) {
    return;
  }

  if (activeExecution.source && activeExecution.source !== source) {
    return;
  }

  const parser = activeExecution.parserBySource[source];
  const result = parser.feed(rawChunk);

  if (!activeExecution.source && result.started) {
    activeExecution.source = source;
    resolveExecutionStartWaiters();
    if (source === "ws") {
      stopDomObserver();
    }
  }

  if (activeExecution.source !== source) {
    return;
  }

  for (const part of result.chunks) {
    const cleanedPart =
      source === "ws" ? cleanEmittedWsOutput(part) : stripBinaryNoise(part);
    if (cleanedPart.length === 0) {
      continue;
    }
    activeExecution.output += cleanedPart;
    emitExecEvent("exec_output", {
      requestId: activeExecution.requestId,
      chunk: cleanedPart,
      source
    });
  }

  if (!result.completed) {
    return;
  }

  const exitCode = result.exitCode ?? 1;
  emitExecEvent("exec_result", {
    requestId: activeExecution.requestId,
    exitCode,
    output: activeExecution.output,
    source,
    startedAt: activeExecution.startedAt,
    endedAt: Date.now()
  });
  cleanupExecution();
}

function emitExecEvent(type, payload) {
  void sendRuntimeMessageSafe({
    type: "bt_exec_event",
    requestId: payload.requestId,
    payload: {
      type,
      ...payload
    }
  });
}

function cleanupExecution() {
  if (!activeExecution) {
    return;
  }

  if (activeExecution.timeoutTimer) {
    clearTimeout(activeExecution.timeoutTimer);
  }
  if (activeExecution.domFallbackTimer) {
    clearTimeout(activeExecution.domFallbackTimer);
  }
  rejectExecutionStartWaiters();
  stopDomObserver();
  activeExecution = null;
}

async function sendInputToTerminal(commandText) {
  const deliveryMethods = [
    {
      name: "trusted-input",
      run: async () => {
        focusTerminalForInput();
        const trustedTyped = await sendTrustedInput(commandText);
        if (!trustedTyped) {
          return false;
        }

        const trustedEnter = await sendTrustedEnter();
        if (trustedEnter) {
          return true;
        }

        return sendEnterFallback();
      }
    },
    {
      name: "socket-input",
      run: async () => {
        const bySocket = await sendPageRequest("send-input", { text: `${commandText}\n` }, 1500).catch(
          () => null
        );
        return Boolean(bySocket?.ok);
      }
    },
    {
      name: "keyboard-input",
      run: async () => {
        focusTerminalForInput();
        const typedByKeyboard = sendInputViaKeyboard(commandText);
        if (!typedByKeyboard) {
          return false;
        }
        return sendEnterViaKeyboard();
      }
    }
  ];

  for (const method of deliveryMethods) {
    const sent = await method.run();
    if (!sent) {
      continue;
    }

    const started = await waitForExecutionStart(START_CONFIRM_TIMEOUT_MS);
    if (started) {
      return true;
    }
  }

  return false;
}

async function sendControlC() {
  focusTerminalForInput();

  const trusted = await sendTrustedCtrlC();
  if (trusted) {
    return true;
  }

  const bySocket = await sendPageRequest("send-ctrl-c", {}, 1000).catch(() => null);
  if (bySocket?.ok) {
    return true;
  }

  return sendCtrlCViaKeyboard();
}

async function sendTrustedInput(text) {
  try {
    const result = await sendRuntimeMessageSafe({
      type: "bt_trusted_input",
      text
    });
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

async function sendTrustedEnter() {
  try {
    const result = await sendRuntimeMessageSafe({
      type: "bt_trusted_enter"
    });
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

async function sendTrustedCtrlC() {
  try {
    const result = await sendRuntimeMessageSafe({
      type: "bt_trusted_ctrl_c"
    });
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

async function sendEnterFallback() {
  const bySocket = await sendPageRequest("send-input", { text: "\n" }, 600).catch(() => null);
  if (bySocket?.ok) {
    return true;
  }
  return sendEnterViaKeyboard();
}

function sendPageRequest(action, payload, timeoutMs) {
  const requestId = `req-${Date.now()}-${pageRequestCounter++}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pageRequests.delete(requestId);
      reject(new Error(`page request timed out (${action})`));
    }, timeoutMs);

    pageRequests.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });

    window.postMessage(
      {
        source: "bt-content-script",
        type: "bt-page-hook-request",
        action,
        payload,
        requestId
      },
      "*"
    );
  });
}

function waitForExecutionStart(timeoutMs) {
  if (!activeExecution) {
    return Promise.resolve(false);
  }

  if (activeExecution.source) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!activeExecution) {
        resolve(false);
        return;
      }

      const index = activeExecution.startWaiters.findIndex((entry) => entry.resolve === resolve);
      if (index >= 0) {
        activeExecution.startWaiters.splice(index, 1);
      }
      resolve(false);
    }, timeoutMs);

    activeExecution.startWaiters.push({
      resolve,
      timer
    });
  });
}

function resolveExecutionStartWaiters() {
  if (!activeExecution) {
    return;
  }

  const waiters = activeExecution.startWaiters.splice(0);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

function rejectExecutionStartWaiters() {
  if (!activeExecution) {
    return;
  }

  const waiters = activeExecution.startWaiters.splice(0);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(false);
  }
}

function startDomObserver() {
  if (domObserver) {
    return;
  }

  const target = findTerminalRoot() || document.body;
  if (!target) {
    return;
  }

  domObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData" && mutation.target?.textContent) {
        domBuffer += mutation.target.textContent;
      }

      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          const text = extractText(node);
          if (text) {
            domBuffer += text;
          }
        }
      }
    }

    if (!domFlushTimer && domBuffer.length > 0) {
      domFlushTimer = setTimeout(() => {
        domFlushTimer = null;
        const chunk = domBuffer;
        domBuffer = "";
        if (chunk.length > 0) {
          handleExecutionChunk("dom", chunk);
        }
      }, 120);
    }
  });

  domObserver.observe(target, {
    subtree: true,
    childList: true,
    characterData: true
  });
}

function stopDomObserver() {
  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
  if (domFlushTimer) {
    clearTimeout(domFlushTimer);
    domFlushTimer = null;
  }
  domBuffer = "";
}

function extractText(node) {
  if (!node) {
    return "";
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node;
  if (element.tagName === "SCRIPT" || element.tagName === "STYLE") {
    return "";
  }
  return element.textContent || "";
}

function isLikelyTerminalPage() {
  if (/terminal|tty|shell|console|ssh/i.test(window.location.href)) {
    return true;
  }
  return Boolean(findTerminalRoot());
}

function findTerminalRoot() {
  const selectors = [
    ".xterm",
    ".xterm-screen",
    ".terminal",
    "[class*=terminal]",
    "[data-testid*=terminal]",
    "pre"
  ];

  for (const selector of selectors) {
    const found = document.querySelector(selector);
    if (found) {
      return found;
    }
  }

  return null;
}

function sendInputViaKeyboard(text) {
  const target = findInputTarget();
  if (!target) {
    return false;
  }

  target.focus();
  const normalized = text.replace(/\r\n/g, "\n");

  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/plain", normalized);
  const pasteEvent = new ClipboardEvent("paste", {
    clipboardData: dataTransfer,
    bubbles: true,
    cancelable: true
  });
  target.dispatchEvent(pasteEvent);

  for (const char of normalized) {
    if (char === "\n") {
      dispatchKey(target, "Enter", "Enter", 13);
    } else {
      dispatchKey(target, char, "", char.charCodeAt(0));
    }
  }

  return true;
}

function sendEnterViaKeyboard() {
  const target = findInputTarget();
  if (!target) {
    return false;
  }
  target.focus();
  dispatchKey(target, "Enter", "Enter", 13);
  return true;
}

function sendCtrlCViaKeyboard() {
  const target = findInputTarget();
  if (!target) {
    return false;
  }
  target.focus();

  const keydown = new KeyboardEvent("keydown", {
    key: "c",
    code: "KeyC",
    keyCode: 67,
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  });
  const keyup = new KeyboardEvent("keyup", {
    key: "c",
    code: "KeyC",
    keyCode: 67,
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  });

  target.dispatchEvent(keydown);
  target.dispatchEvent(keyup);
  return true;
}

function dispatchKey(target, key, code, keyCode) {
  const down = new KeyboardEvent("keydown", {
    key,
    code,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true
  });
  const press = new KeyboardEvent("keypress", {
    key,
    code,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true
  });
  const up = new KeyboardEvent("keyup", {
    key,
    code,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true
  });

  target.dispatchEvent(down);
  target.dispatchEvent(press);
  target.dispatchEvent(up);
}

function findInputTarget() {
  const selectors = [
    ".xterm-helper-textarea",
    "textarea",
    "[contenteditable=true]",
    "input[type=text]",
    "input:not([type])"
  ];

  if (document.activeElement && isElementEditable(document.activeElement)) {
    return document.activeElement;
  }

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) {
      return element;
    }
  }

  return document.body;
}

function focusTerminalForInput() {
  const root = findTerminalRoot();
  if (root instanceof HTMLElement) {
    root.focus();
    root.click();
  }

  const target = findInputTarget();
  if (target && typeof target.focus === "function") {
    target.focus();
    if (target instanceof HTMLElement) {
      target.click();
    }
  }
}

function isElementEditable(element) {
  if (!element || !(element instanceof HTMLElement)) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  if (element instanceof HTMLTextAreaElement) {
    return true;
  }

  if (element instanceof HTMLInputElement) {
    return ["text", "search", "url", "email", "tel", "password", ""].includes(element.type);
  }

  return false;
}

function normalizeTimeout(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return COMMAND_TIMEOUT_FALLBACK_MS;
  }
  return Math.max(1000, Math.floor(value));
}

function buildMarkers(requestId) {
  const id = String(requestId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || "req";
  return {
    id,
    start: `__BT_START_${id}__`,
    rcPrefix: `__BT_RC_${id}__:`,
    end: `__BT_END_${id}__`
  };
}

function buildWrappedCommand(command, markers) {
  const normalized = String(command || "").trimEnd();
  const body = normalized.length > 0 ? normalized : ":";
  return [
    `printf '${markers.start}\\n'`,
    `( ${body} )`,
    "__bt_rc=$?",
    `printf '${markers.rcPrefix}%s\\n' \"$__bt_rc\"`,
    `printf '${markers.end}\\n'`
  ].join("; ");
}

function trimSingleLeadingNewline(input) {
  if (input.startsWith("\r\n")) {
    return input.slice(2);
  }
  if (input.startsWith("\n") || input.startsWith("\r")) {
    return input.slice(1);
  }
  return input;
}

function cleanEmittedWsOutput(chunk) {
  const normalized = stripBinaryNoise(chunk);
  if (!normalized) {
    return "";
  }

  if (!looksLikeRpcNoise(normalized)) {
    return normalized;
  }

  const lines = normalized.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (!line) {
      kept.push(line);
      continue;
    }
    if (isRpcNoiseLine(line)) {
      continue;
    }
    kept.push(line);
  }

  return kept.join("\n");
}

function looksLikeRpcNoise(text) {
  return (
    typeof text === "string" &&
    (text.includes("RPCService") ||
      text.includes("ITerminalServicePath") ||
      text.includes("ExtMainThreadConnection") ||
      text.includes("MainThreadStatusBar/") ||
      text.includes("plugin-status-bar-item:") ||
      text.includes("extension_extend_service:"))
  );
}

function stripBinaryNoise(text) {
  if (typeof text !== "string") {
    return "";
  }
  return text.replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, "");
}

function isRpcNoiseLine(line) {
  if (typeof line !== "string") {
    return false;
  }

  return (
    line.includes("RPCService") ||
    line.includes("ITerminalServicePath") ||
    line.includes("ExtMainThreadConnection") ||
    line.includes("MainThreadStatusBar/") ||
    line.includes("plugin-status-bar-item:") ||
    line.includes("extension_extend_service:") ||
    line.includes("aistudio-monitor (扩展)")
  );
}

function findStartMarkerIndex(buffer, marker) {
  let from = 0;
  while (true) {
    const idx = buffer.indexOf(marker, from);
    if (idx < 0) {
      return -1;
    }

    const afterPos = idx + marker.length;
    if (afterPos >= buffer.length) {
      return -1;
    }

    if (isMarkerTerminator(buffer, afterPos)) {
      return idx;
    }

    from = idx + 1;
  }
}

function keepPotentialStartPrefix(buffer, marker) {
  const max = Math.min(marker.length - 1, buffer.length);
  for (let size = max; size > 0; size -= 1) {
    const suffix = buffer.slice(buffer.length - size);
    if (marker.startsWith(suffix)) {
      return suffix;
    }
  }
  return "";
}

function isMarkerTerminator(buffer, pos) {
  const ch = buffer[pos];
  if (!ch) {
    return false;
  }
  if (ch === "\n" || ch === "\r") {
    return true;
  }
  if (ch === "\\" && pos + 1 < buffer.length) {
    const esc = buffer[pos + 1];
    if (esc === "n" || esc === "r") {
      const next = buffer[pos + 2] || "";
      if (next === "'") {
        return false;
      }
      return true;
    }
  }
  const code = ch.charCodeAt(0);
  return code >= 0 && code <= 0x1f;
}

function sendRuntimeMessageSafe(message) {
  if (!canUseRuntime()) {
    return Promise.resolve(null);
  }

  try {
    return chrome.runtime.sendMessage(message).catch((error) => {
      if (isRuntimeInvalidatedError(error)) {
        handleRuntimeInvalidated();
        return null;
      }
      throw error;
    });
  } catch (error) {
    if (isRuntimeInvalidatedError(error)) {
      handleRuntimeInvalidated();
      return Promise.resolve(null);
    }
    return Promise.reject(error);
  }
}

function canUseRuntime() {
  return runtimeAvailable && Boolean(chrome?.runtime?.id);
}

function isRuntimeInvalidatedError(error) {
  const text = String(error ?? "");
  return EXTENSION_CONTEXT_INVALIDATED_PATTERNS.some((pattern) => text.includes(pattern));
}

function handleRuntimeInvalidated() {
  if (!runtimeAvailable) {
    return;
  }
  runtimeAvailable = false;

  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }

  if (activeExecution?.timeoutTimer) {
    clearTimeout(activeExecution.timeoutTimer);
  }
  if (activeExecution?.domFallbackTimer) {
    clearTimeout(activeExecution.domFallbackTimer);
  }
  activeExecution = null;
  stopDomObserver();

  for (const pending of pageRequests.values()) {
    pending.reject(new Error("extension runtime unavailable"));
  }
  pageRequests.clear();
}
