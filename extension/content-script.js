const STATUS_INTERVAL_MS = 5000;
const COMMAND_TIMEOUT_FALLBACK_MS = 120000;

let activeExecution = null;
let pageRequestCounter = 0;
let statusTimer = null;
let domObserver = null;
let domFlushTimer = null;
let domBuffer = "";
const pageRequests = new Map();

injectPageHook();
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
      sendStatus(Boolean(message.hasTerminalSocket));
    }
  });
}

function startStatusHeartbeat() {
  sendStatus(false);
  statusTimer = setInterval(async () => {
    const hook = await sendPageRequest("status", {}, 800).catch(() => null);
    const likely = isLikelyTerminalPage() || Boolean(hook?.hasTerminalSocket);
    sendStatus(likely);
  }, STATUS_INTERVAL_MS);
}

function sendStatus(likelyTerminal) {
  chrome.runtime.sendMessage({
    type: "bt_terminal_status",
    likelyTerminal,
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
    markerStartTimer: null,
    domFallbackTimer: null,
    wsObserved: false
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

  activeExecution.domFallbackTimer = setTimeout(() => {
    if (activeExecution && !activeExecution.wsObserved && !domObserver) {
      startDomObserver();
    }
  }, 1500);

  const markerWaitMs = Math.min(15000, Math.max(4000, Math.floor(activeExecution.timeoutMs / 3)));
  activeExecution.markerStartTimer = setTimeout(() => {
    if (!activeExecution || activeExecution.requestId !== message.requestId || activeExecution.source) {
      return;
    }

    emitExecEvent("exec_error", {
      requestId: message.requestId,
      message:
        "no command markers observed in terminal output; output capture may be incompatible with this terminal page"
    });
    sendControlC().catch(() => {
      // ignored
    });
    cleanupExecution();
  }, markerWaitMs);

  const sent = await sendInputToTerminal(wrappedCommand);
  if (!sent) {
    emitExecEvent("exec_error", {
      requestId: message.requestId,
      message: "failed to deliver command to terminal"
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

  let normalizedChunk = chunk;
  if (source === "ws") {
    normalizedChunk = sanitizeWsChunk(chunk);
    if (!normalizedChunk) {
      return;
    }
  }

  if (source === "ws") {
    activeExecution.wsObserved = true;
  }

  if (activeExecution.source && activeExecution.source !== source) {
    return;
  }

  const parser = activeExecution.parserBySource[source];
  const result = parser.feed(normalizedChunk);

  if (!activeExecution.source && result.started) {
    activeExecution.source = source;
    clearMarkerStartTimer();
    if (source === "ws") {
      stopDomObserver();
    }
  }

  if (activeExecution.source !== source) {
    return;
  }

  for (const part of result.chunks) {
    if (part.length === 0) {
      continue;
    }
    activeExecution.output += part;
    emitExecEvent("exec_output", {
      requestId: activeExecution.requestId,
      chunk: part,
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
  chrome.runtime.sendMessage({
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
  if (activeExecution.markerStartTimer) {
    clearTimeout(activeExecution.markerStartTimer);
  }
  if (activeExecution.domFallbackTimer) {
    clearTimeout(activeExecution.domFallbackTimer);
  }
  stopDomObserver();
  activeExecution = null;
}

function clearMarkerStartTimer() {
  if (!activeExecution || !activeExecution.markerStartTimer) {
    return;
  }
  clearTimeout(activeExecution.markerStartTimer);
  activeExecution.markerStartTimer = null;
}

async function sendInputToTerminal(commandText) {
  const trusted = await sendTrustedInput(commandText);
  if (trusted) {
    const enterOk = await sendTrustedEnter();
    if (enterOk) {
      return true;
    }
  }

  const bySocket = await sendPageRequest("send-input", { text: `${commandText}\n` }, 1500).catch(
    () => null
  );
  if (bySocket?.ok) {
    return true;
  }

  return sendInputViaKeyboard(`${commandText}\n`);
}

async function sendControlC() {
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
    const result = await chrome.runtime.sendMessage({
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
    const result = await chrome.runtime.sendMessage({
      type: "bt_trusted_enter"
    });
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

async function sendTrustedCtrlC() {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "bt_trusted_ctrl_c"
    });
    return Boolean(result?.ok);
  } catch {
    return false;
  }
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

function sanitizeWsChunk(chunk) {
  if (typeof chunk !== "string" || chunk.length === 0) {
    return "";
  }

  if (!looksLikeRpcNoise(chunk)) {
    return chunk;
  }

  const byPrefixRegex = chunk.replace(
    /[^\n\r]*RPCService[^\n\r]*ITerminalServicePath:onMessage[^\n\r]*?(?:[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]+)+/g,
    ""
  );
  if (byPrefixRegex !== chunk) {
    return byPrefixRegex;
  }

  const marker = "ITerminalServicePath:onMessage";
  const idx = chunk.lastIndexOf(marker);
  if (idx >= 0) {
    const tail = chunk.slice(idx + marker.length);
    const parts = tail
      .split(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g)
      .map((item) => item.trimStart())
      .filter(Boolean);

    for (const part of parts) {
      if (/RPCService|ITerminalServicePath:onMessage/.test(part)) {
        continue;
      }
      if (/^\"?[A-Za-z0-9_-]+\|[A-Za-z0-9_-]+\"?$/.test(part)) {
        continue;
      }
      return part;
    }
  }

  return chunk.replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, "");
}

function looksLikeRpcNoise(text) {
  return (
    typeof text === "string" &&
    (text.includes("RPCService") || text.includes("ITerminalServicePath:onMessage"))
  );
}

function findStartMarkerIndex(buffer, marker) {
  let from = 0;
  while (true) {
    const idx = buffer.indexOf(marker, from);
    if (idx < 0) {
      return -1;
    }

    const beforeOk = idx === 0 || buffer[idx - 1] === "\n" || buffer[idx - 1] === "\r";
    if (!beforeOk) {
      from = idx + 1;
      continue;
    }
    return idx;
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

function injectPageHook() {
  if (window.__btPageHookInjected) {
    return;
  }
  window.__btPageHookInjected = true;

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-hook.js");
  script.async = false;

  const parent = document.documentElement || document.head || document.body;
  if (!parent) {
    return;
  }

  parent.appendChild(script);
  script.remove();
}
