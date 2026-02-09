import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { PROTOCOL_VERSION, safeParseMessage, stringifyMessage } from "@bt/shared";
export class BridgeServer {
    config;
    startedAt = Date.now();
    socketStates = new WeakMap();
    cliSockets = new Set();
    requests = new Map();
    queue = [];
    httpServer = null;
    wsServer = null;
    extensionSocket = null;
    pingTimer = null;
    activeRequestId = null;
    constructor(config) {
        this.config = config;
    }
    async start() {
        if (this.httpServer) {
            return;
        }
        this.httpServer = createServer((req, res) => {
            this.handleHttpRequest(req, res);
        });
        this.wsServer = new WebSocketServer({ noServer: true });
        this.httpServer.on("upgrade", (req, socket, head) => {
            this.handleUpgrade(req, socket, head);
        });
        await new Promise((resolve, reject) => {
            this.httpServer?.once("error", reject);
            this.httpServer?.listen(this.config.port, this.config.host, () => resolve());
        });
        this.pingTimer = setInterval(() => {
            this.sendPings();
        }, this.config.pingIntervalMs);
        this.log("info", `bridge listening on ws://${this.config.host}:${this.config.port} (cli=/cli, extension=/extension)`);
        if (this.config.token) {
            this.log("info", "token auth is enabled");
        }
    }
    async stop() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        for (const socket of this.cliSockets) {
            safeClose(socket, 1001, "server_stopping");
        }
        this.cliSockets.clear();
        if (this.extensionSocket) {
            safeClose(this.extensionSocket, 1001, "server_stopping");
            this.extensionSocket = null;
        }
        if (this.wsServer) {
            await new Promise((resolve) => this.wsServer?.close(() => resolve()));
            this.wsServer = null;
        }
        if (this.httpServer) {
            await new Promise((resolve) => this.httpServer?.close(() => resolve()));
            this.httpServer = null;
        }
    }
    handleHttpRequest(req, res) {
        const url = new URL(req.url ?? "/", `http://${this.config.host}:${this.config.port}`);
        if (req.method === "GET" && url.pathname === "/v1/health") {
            const payload = this.healthPayload();
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(payload));
            return;
        }
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "not_found" }));
    }
    handleUpgrade(req, socket, head) {
        if (!this.wsServer) {
            socket.destroy();
            return;
        }
        const url = new URL(req.url ?? "/", `http://${this.config.host}:${this.config.port}`);
        const pathname = url.pathname;
        if (pathname !== "/cli" && pathname !== "/extension") {
            socket.destroy();
            return;
        }
        const roleHint = pathname === "/cli" ? "cli" : "extension";
        this.wsServer.handleUpgrade(req, socket, head, (ws) => {
            this.wsServer?.emit("connection", ws, req);
            this.onSocketConnection(ws, roleHint);
        });
    }
    onSocketConnection(ws, roleHint) {
        const state = {
            id: randomUUID(),
            roleHint,
            authed: false,
            clientId: "unknown",
            isAlive: true
        };
        this.socketStates.set(ws, state);
        const helloTimeout = setTimeout(() => {
            if (!state.authed) {
                this.sendError(ws, {
                    type: "error",
                    code: "unauthorized",
                    message: "hello handshake required"
                });
                safeClose(ws, 4401, "hello_required");
            }
        }, 10000);
        ws.on("pong", () => {
            state.isAlive = true;
        });
        ws.on("message", (buffer, isBinary) => {
            if (isBinary) {
                this.sendError(ws, {
                    type: "error",
                    code: "invalid_payload",
                    message: "binary messages are not supported"
                });
                return;
            }
            const text = buffer.toString("utf8");
            const message = safeParseMessage(text);
            if (!message) {
                this.sendError(ws, {
                    type: "error",
                    code: "invalid_json",
                    message: "failed to parse message"
                });
                return;
            }
            if (!state.authed) {
                if (message.type !== "hello") {
                    this.sendError(ws, {
                        type: "error",
                        code: "unauthorized",
                        message: "first message must be hello"
                    });
                    safeClose(ws, 4401, "hello_required");
                    return;
                }
                const ok = this.authenticate(ws, message, state);
                if (!ok) {
                    return;
                }
                clearTimeout(helloTimeout);
                return;
            }
            this.onAuthedMessage(ws, state, message);
        });
        ws.on("close", () => {
            clearTimeout(helloTimeout);
            this.onSocketClosed(ws, state);
        });
        ws.on("error", (err) => {
            this.log("debug", `socket error [${state.roleHint}:${state.id}] ${String(err)}`);
        });
    }
    authenticate(ws, hello, state) {
        if (hello.protocolVersion !== PROTOCOL_VERSION) {
            this.sendError(ws, {
                type: "error",
                code: "protocol_mismatch",
                message: `expected protocolVersion=${PROTOCOL_VERSION}`
            });
            safeClose(ws, 4401, "protocol_mismatch");
            return false;
        }
        if (hello.role !== state.roleHint) {
            this.sendError(ws, {
                type: "error",
                code: "role_mismatch",
                message: `expected role ${state.roleHint}`
            });
            safeClose(ws, 4401, "role_mismatch");
            return false;
        }
        if (this.config.token && hello.token !== this.config.token) {
            this.sendError(ws, {
                type: "error",
                code: "bad_token",
                message: "invalid token"
            });
            safeClose(ws, 4401, "bad_token");
            return false;
        }
        state.authed = true;
        state.role = hello.role;
        state.clientId = hello.clientId ?? state.id;
        if (hello.role === "cli") {
            this.cliSockets.add(ws);
        }
        else {
            if (this.extensionSocket && this.extensionSocket !== ws) {
                this.sendError(this.extensionSocket, {
                    type: "error",
                    code: "replaced",
                    message: "another extension connection replaced this one"
                });
                safeClose(this.extensionSocket, 4000, "replaced");
            }
            this.extensionSocket = ws;
            this.log("info", "extension connected");
            this.dispatchQueue();
        }
        const ack = {
            type: "hello_ack",
            role: hello.role,
            protocolVersion: PROTOCOL_VERSION,
            serverTime: Date.now()
        };
        this.send(ws, ack);
        return true;
    }
    onAuthedMessage(ws, state, message) {
        if (message.type === "pong") {
            state.isAlive = true;
            return;
        }
        if (state.role === "cli") {
            this.handleCliMessage(ws, message);
            return;
        }
        if (state.role === "extension") {
            this.handleExtensionMessage(message);
            return;
        }
    }
    handleCliMessage(ws, message) {
        if (message.type === "health") {
            const health = {
                type: "health_result",
                ...this.healthPayload()
            };
            this.send(ws, health);
            return;
        }
        if (message.type === "exec") {
            this.enqueueExec(ws, message);
            return;
        }
        if (message.type === "cancel") {
            this.cancelRequest(ws, message);
            return;
        }
        this.sendError(ws, {
            type: "error",
            code: "unsupported_message",
            message: `unsupported cli message type: ${message.type}`
        });
    }
    enqueueExec(ws, message) {
        const requestId = message.requestId;
        if (!requestId || typeof requestId !== "string") {
            this.sendError(ws, {
                type: "error",
                code: "bad_request",
                message: "requestId is required"
            });
            return;
        }
        if (this.requests.has(requestId)) {
            this.sendError(ws, {
                type: "error",
                code: "duplicate_request_id",
                message: `requestId already exists: ${requestId}`,
                requestId
            });
            return;
        }
        if (typeof message.command !== "string" || message.command.length === 0) {
            this.sendError(ws, {
                type: "error",
                code: "bad_request",
                message: "command must be a non-empty string",
                requestId
            });
            return;
        }
        if (!this.extensionSocket || this.extensionSocket.readyState !== WebSocket.OPEN) {
            const payload = {
                type: "exec_error",
                requestId,
                message: "extension is not connected"
            };
            this.send(ws, payload);
            return;
        }
        const timeoutMs = normalizeTimeout(message.timeoutMs, this.config.defaultTimeoutMs, this.config.maxTimeoutMs);
        const state = {
            requestId,
            command: message.command,
            timeoutMs,
            cli: ws,
            ownerClientId: this.socketStates.get(ws)?.clientId ?? "unknown",
            status: "queued",
            createdAt: Date.now()
        };
        this.requests.set(requestId, state);
        this.queue.push(requestId);
        this.send(ws, {
            type: "queued",
            requestId,
            position: this.queue.length
        });
        this.dispatchQueue();
    }
    cancelRequest(ws, message) {
        const request = this.requests.get(message.requestId);
        if (!request) {
            this.sendError(ws, {
                type: "error",
                code: "not_found",
                message: `unknown requestId: ${message.requestId}`,
                requestId: message.requestId
            });
            return;
        }
        const callerClientId = this.socketStates.get(ws)?.clientId ?? "unknown";
        if (request.ownerClientId !== callerClientId) {
            this.sendError(ws, {
                type: "error",
                code: "forbidden",
                message: `requestId ${message.requestId} belongs to client ${request.ownerClientId}`,
                requestId: message.requestId
            });
            return;
        }
        if (request.status === "queued") {
            removeFromQueue(this.queue, request.requestId);
            this.requests.delete(request.requestId);
            this.send(ws, {
                type: "exec_cancelled",
                requestId: request.requestId,
                reason: message.reason ?? "cancelled_while_queued"
            });
            return;
        }
        if (request.status === "running") {
            if (this.extensionSocket) {
                const payload = {
                    type: "exec_cancel",
                    requestId: request.requestId,
                    reason: message.reason ?? "cancel_requested"
                };
                this.send(this.extensionSocket, payload);
            }
            else {
                this.failRequest(request.requestId, "extension disconnected during cancel");
            }
            return;
        }
    }
    handleExtensionMessage(message) {
        if (message.type === "terminal_status") {
            const status = message;
            this.log("debug", `terminal status: count=${status.terminalCount}, active=${status.activeTabId}, bound=${status.boundTabId}`);
            return;
        }
        if (message.type === "exec_started" ||
            message.type === "exec_output" ||
            message.type === "exec_result" ||
            message.type === "exec_error" ||
            message.type === "exec_cancelled") {
            this.forwardExecutionEvent(message);
            return;
        }
        this.log("debug", `ignored extension message type: ${message.type}`);
    }
    forwardExecutionEvent(message) {
        const request = this.requests.get(message.requestId);
        if (!request) {
            this.log("debug", `received ${message.type} for unknown request ${message.requestId}`);
            return;
        }
        if (message.type === "exec_started") {
            request.startedAt = message.startedAt;
            this.send(request.cli, message);
            return;
        }
        if (message.type === "exec_output") {
            this.send(request.cli, message);
            return;
        }
        if (message.type === "exec_result") {
            this.send(request.cli, message);
            this.completeRequest(message.requestId);
            return;
        }
        if (message.type === "exec_cancelled") {
            this.send(request.cli, message);
            this.completeRequest(message.requestId);
            return;
        }
        if (message.type === "exec_error") {
            this.send(request.cli, message);
            this.completeRequest(message.requestId);
            return;
        }
    }
    dispatchQueue() {
        if (this.activeRequestId) {
            return;
        }
        if (!this.extensionSocket || this.extensionSocket.readyState !== WebSocket.OPEN) {
            return;
        }
        while (this.queue.length > 0) {
            const requestId = this.queue.shift();
            if (!requestId) {
                break;
            }
            const request = this.requests.get(requestId);
            if (!request) {
                continue;
            }
            if (request.cli.readyState !== WebSocket.OPEN) {
                this.requests.delete(requestId);
                continue;
            }
            request.status = "running";
            request.startedAt = Date.now();
            this.activeRequestId = requestId;
            request.watchdog = setTimeout(() => {
                this.log("info", `request timed out in bridge watchdog: ${requestId}`);
                if (this.extensionSocket && this.extensionSocket.readyState === WebSocket.OPEN) {
                    this.send(this.extensionSocket, {
                        type: "exec_cancel",
                        requestId,
                        reason: "bridge_watchdog_timeout"
                    });
                }
                setTimeout(() => {
                    if (this.requests.has(requestId)) {
                        this.failRequest(requestId, "request timed out before completion");
                    }
                }, 5000);
            }, request.timeoutMs + 5000);
            const payload = {
                type: "exec_request",
                requestId,
                command: request.command,
                timeoutMs: request.timeoutMs,
                createdAt: request.createdAt
            };
            this.send(this.extensionSocket, payload);
            break;
        }
    }
    completeRequest(requestId) {
        const request = this.requests.get(requestId);
        if (!request) {
            return;
        }
        if (request.watchdog) {
            clearTimeout(request.watchdog);
        }
        this.requests.delete(requestId);
        if (this.activeRequestId === requestId) {
            this.activeRequestId = null;
        }
        this.dispatchQueue();
    }
    failRequest(requestId, message) {
        const request = this.requests.get(requestId);
        if (!request) {
            return;
        }
        const payload = {
            type: "exec_error",
            requestId,
            message
        };
        if (request.cli.readyState === WebSocket.OPEN) {
            this.send(request.cli, payload);
        }
        this.completeRequest(requestId);
    }
    onSocketClosed(ws, state) {
        if (state.role === "cli") {
            this.cliSockets.delete(ws);
            this.cancelRequestsOwnedByCli(ws);
            return;
        }
        if (state.role === "extension") {
            if (this.extensionSocket === ws) {
                this.extensionSocket = null;
                this.log("info", "extension disconnected");
                if (this.activeRequestId) {
                    this.failRequest(this.activeRequestId, "extension disconnected during execution");
                }
            }
            return;
        }
    }
    cancelRequestsOwnedByCli(ws) {
        for (const [requestId, request] of this.requests.entries()) {
            if (request.cli !== ws) {
                continue;
            }
            if (request.status === "queued") {
                removeFromQueue(this.queue, requestId);
                this.requests.delete(requestId);
                continue;
            }
            if (request.status === "running") {
                if (this.extensionSocket && this.extensionSocket.readyState === WebSocket.OPEN) {
                    const payload = {
                        type: "exec_cancel",
                        requestId,
                        reason: "cli_disconnected"
                    };
                    this.send(this.extensionSocket, payload);
                }
                else {
                    this.failRequest(requestId, "cli disconnected and extension unavailable");
                }
            }
        }
    }
    healthPayload() {
        return {
            extensionConnected: Boolean(this.extensionSocket && this.extensionSocket.readyState === WebSocket.OPEN),
            queuedCount: this.queue.length,
            activeRequestId: this.activeRequestId,
            uptimeMs: Date.now() - this.startedAt,
            serverTime: Date.now()
        };
    }
    sendPings() {
        const ping = {
            type: "ping",
            ts: Date.now()
        };
        if (this.extensionSocket && this.extensionSocket.readyState === WebSocket.OPEN) {
            const state = this.socketStates.get(this.extensionSocket);
            if (state && !state.isAlive) {
                safeClose(this.extensionSocket, 4001, "ping_timeout");
            }
            if (state) {
                state.isAlive = false;
            }
            this.send(this.extensionSocket, ping);
            this.extensionSocket.ping();
        }
        for (const cli of this.cliSockets) {
            if (cli.readyState !== WebSocket.OPEN) {
                continue;
            }
            const state = this.socketStates.get(cli);
            if (state && !state.isAlive) {
                safeClose(cli, 4001, "ping_timeout");
                continue;
            }
            if (state) {
                state.isAlive = false;
            }
            this.send(cli, ping);
            cli.ping();
        }
    }
    send(ws, payload) {
        if (ws.readyState !== WebSocket.OPEN) {
            return;
        }
        ws.send(stringifyMessage(payload));
    }
    sendError(ws, message) {
        this.send(ws, message);
    }
    log(level, message) {
        if (level === "debug" && this.config.logLevel !== "debug") {
            return;
        }
        // eslint-disable-next-line no-console
        console.log(`[bridge:${level}] ${message}`);
    }
}
function normalizeTimeout(input, fallback, max) {
    if (input === undefined || !Number.isFinite(input)) {
        return fallback;
    }
    if (input < 1000) {
        return 1000;
    }
    if (input > max) {
        return max;
    }
    return Math.floor(input);
}
function safeClose(ws, code, reason) {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        return;
    }
    ws.close(code, reason.slice(0, 123));
}
function removeFromQueue(queue, requestId) {
    const index = queue.indexOf(requestId);
    if (index >= 0) {
        queue.splice(index, 1);
    }
}
//# sourceMappingURL=server.js.map