(() => {
  if (window.__btPageHookInstalled) {
    return;
  }
  window.__btPageHookInstalled = true;

  const sockets = new Set();
  const socketMeta = new WeakMap();
  const encoder = new TextEncoder();

  patchWebSocket();
  emitStatus();

  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || typeof event.data !== "object") {
      return;
    }

    const message = event.data;
    if (message.source !== "bt-content-script" || message.type !== "bt-page-hook-request") {
      return;
    }

    const { action, payload, requestId } = message;

    try {
      if (action === "send-input") {
        const socket = pickSocket();
        if (!socket) {
          respond(requestId, false, null, "no websocket candidate for terminal input");
          return;
        }

        sendText(socket, String(payload?.text ?? ""));
        respond(requestId, true, { ok: true, url: socketMeta.get(socket)?.url ?? "" });
        return;
      }

      if (action === "send-ctrl-c") {
        const socket = pickSocket();
        if (!socket) {
          respond(requestId, false, null, "no websocket candidate for terminal input");
          return;
        }

        sendText(socket, "\u0003");
        respond(requestId, true, { ok: true, url: socketMeta.get(socket)?.url ?? "" });
        return;
      }

      if (action === "status") {
        respond(requestId, true, {
          socketCount: [...sockets].filter((socket) => socket.readyState === WebSocket.OPEN).length,
          hasTerminalSocket: Boolean(pickSocket())
        });
        return;
      }

      respond(requestId, false, null, `unknown action: ${String(action)}`);
    } catch (error) {
      respond(requestId, false, null, String(error));
    }
  });

  function patchWebSocket() {
    const NativeWebSocket = window.WebSocket;
    const ProxiedWebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget);
        registerSocket(ws, args[0]);
        return ws;
      }
    });

    Object.defineProperties(ProxiedWebSocket, {
      CONNECTING: { value: NativeWebSocket.CONNECTING },
      OPEN: { value: NativeWebSocket.OPEN },
      CLOSING: { value: NativeWebSocket.CLOSING },
      CLOSED: { value: NativeWebSocket.CLOSED }
    });

    ProxiedWebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket = ProxiedWebSocket;
  }

  function registerSocket(ws, rawUrl) {
    sockets.add(ws);

    const meta = {
      url: typeof rawUrl === "string" ? rawUrl : String(rawUrl || ""),
      createdAt: Date.now(),
      lastIncomingAt: 0,
      lastOutgoingAt: 0,
      incomingCount: 0,
      outgoingCount: 0,
      lastOutgoingType: "string"
    };

    socketMeta.set(ws, meta);

    const originalSend = ws.send.bind(ws);
    ws.send = (data) => {
      const type = classifyDataType(data);
      meta.lastOutgoingType = type;
      meta.lastOutgoingAt = Date.now();
      meta.outgoingCount += 1;
      return originalSend(data);
    };

    ws.addEventListener("message", (event) => {
      meta.lastIncomingAt = Date.now();
      meta.incomingCount += 1;
      emitChunk(event.data, meta.url).catch(() => {
        // ignored
      });
    });

    ws.addEventListener("close", () => {
      sockets.delete(ws);
      emitStatus();
    });

    ws.addEventListener("open", () => {
      emitStatus();
    });

    emitStatus();
  }

  async function emitChunk(data, url) {
    const decoded = await decodeData(data);
    if (!decoded) {
      return;
    }

    window.postMessage(
      {
        source: "bt-page-hook",
        type: "bt-page-hook-output",
        chunk: decoded,
        url
      },
      "*"
    );
  }

  function emitStatus() {
    window.postMessage(
      {
        source: "bt-page-hook",
        type: "bt-page-hook-status",
        hasTerminalSocket: Boolean(pickSocket())
      },
      "*"
    );
  }

  function pickSocket() {
    const now = Date.now();
    let best = null;
    let bestScore = -Infinity;

    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      const meta = socketMeta.get(ws);
      if (!meta) {
        continue;
      }

      let score = 0;
      if (/term|tty|pty|shell|ssh|console/i.test(meta.url)) {
        score += 8;
      }
      if (now - meta.lastIncomingAt < 15000) {
        score += 3;
      }
      if (now - meta.lastOutgoingAt < 15000) {
        score += 2;
      }
      score += Math.min(meta.incomingCount, 6);
      score += Math.min(meta.outgoingCount, 4);

      if (score > bestScore) {
        bestScore = score;
        best = ws;
      }
    }

    return best;
  }

  function sendText(ws, text) {
    const meta = socketMeta.get(ws);
    const outgoingType = meta?.lastOutgoingType ?? "string";

    if (outgoingType === "arraybuffer") {
      ws.send(encoder.encode(text).buffer);
      return;
    }

    if (outgoingType === "uint8array") {
      ws.send(encoder.encode(text));
      return;
    }

    if (outgoingType === "blob") {
      ws.send(new Blob([text]));
      return;
    }

    ws.send(text);
  }

  function classifyDataType(data) {
    if (typeof data === "string") {
      return "string";
    }
    if (data instanceof ArrayBuffer) {
      return "arraybuffer";
    }
    if (data instanceof Blob) {
      return "blob";
    }
    if (data instanceof Uint8Array) {
      return "uint8array";
    }
    return "string";
  }

  async function decodeData(data) {
    if (typeof data === "string") {
      return maybeExtractTerminalText(data);
    }

    if (data instanceof ArrayBuffer) {
      return maybeExtractTerminalText(decodeBuffer(new Uint8Array(data)));
    }

    if (data instanceof Uint8Array) {
      return maybeExtractTerminalText(decodeBuffer(data));
    }

    if (data instanceof Blob) {
      const buffer = await data.arrayBuffer();
      return maybeExtractTerminalText(decodeBuffer(new Uint8Array(buffer)));
    }

    return "";
  }

  function decodeBuffer(bytes) {
    try {
      return new TextDecoder().decode(bytes);
    } catch {
      return "";
    }
  }

  function maybeExtractTerminalText(text) {
    if (!text) {
      return "";
    }

    const trimmed = text.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
      return text;
    }

    try {
      const parsed = JSON.parse(trimmed);
      const extracted = extractTextCandidate(parsed);
      return extracted || text;
    } catch {
      return text;
    }
  }

  function extractTextCandidate(value) {
    if (typeof value === "string") {
      return value;
    }

    if (Array.isArray(value)) {
      let joined = "";
      for (const item of value) {
        const candidate = extractTextCandidate(item);
        if (candidate) {
          joined += candidate;
        }
      }
      return joined;
    }

    if (!value || typeof value !== "object") {
      return "";
    }

    const preferred = ["data", "output", "stdout", "stderr", "message", "chunk", "text", "payload"];
    for (const key of preferred) {
      if (typeof value[key] === "string") {
        return value[key];
      }
    }

    for (const key of preferred) {
      const nested = extractTextCandidate(value[key]);
      if (nested) {
        return nested;
      }
    }

    return "";
  }

  function respond(requestId, ok, payload = null, error = null) {
    window.postMessage(
      {
        source: "bt-page-hook",
        type: "bt-page-hook-response",
        requestId,
        ok,
        payload,
        error
      },
      "*"
    );
  }
})();
