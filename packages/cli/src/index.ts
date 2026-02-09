#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import process from "node:process";
import WebSocket, { type RawData } from "ws";
import {
  PROTOCOL_VERSION,
  safeParseMessage,
  stringifyMessage,
  type WireMessage,
  type ExecMessage,
  type CancelMessage,
  type HealthMessage,
  type HelloMessage,
  type PongMessage
} from "@bt/shared";

interface GlobalOptions {
  host: string;
  port: number;
  token?: string;
  clientId: string;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const { options, remaining } = parseGlobalOptions(argv);
  const command = remaining[0];

  if (!command) {
    printHelp();
    process.exit(1);
  }

  if (command === "health") {
    await runHealth(options);
    return;
  }

  if (command === "exec") {
    await runExec(options, remaining.slice(1));
    return;
  }

  if (command === "cancel") {
    await runCancel(options, remaining.slice(1));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

async function runHealth(options: GlobalOptions): Promise<void> {
  const ws = await connectCli(options);

  const payload: HealthMessage = { type: "health" };
  ws.send(stringifyMessage(payload));

  const result = await waitForMessage(ws, (message) => message.type === "health_result");
  if (!result || result.type !== "health_result") {
    throw new Error("did not receive health_result");
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  ws.close(1000, "done");
}

async function runExec(options: GlobalOptions, args: string[]): Promise<void> {
  const parsed = parseExecArgs(args);
  const ws = await connectCli(options);

  const requestId = parsed.requestId ?? randomUUID();
  const execPayload: ExecMessage = {
    type: "exec",
    requestId,
    command: parsed.command,
    timeoutMs: parsed.timeoutMs
  };

  let output = "";
  let finalized = false;

  const onSigint = (): void => {
    const cancelPayload: CancelMessage = {
      type: "cancel",
      requestId,
      reason: "local_sigint"
    };
    ws.send(stringifyMessage(cancelPayload));
  };

  process.on("SIGINT", onSigint);

  await new Promise<void>((resolve, reject) => {
    ws.on("message", (buffer, isBinary) => {
      if (isBinary) {
        return;
      }

      const message = safeParseMessage(buffer.toString("utf8"));
      if (!message) {
        return;
      }

      if (message.type === "ping") {
        const pong: PongMessage = { type: "pong", ts: Date.now() };
        ws.send(stringifyMessage(pong));
        return;
      }

      if (message.type === "queued" && message.requestId === requestId) {
        if (!parsed.json) {
          process.stderr.write(`[queued] requestId=${requestId} position=${message.position}\n`);
        }
        return;
      }

      if (message.type === "exec_started" && message.requestId === requestId) {
        if (!parsed.json) {
          process.stderr.write(`[started] requestId=${requestId}\n`);
        }
        return;
      }

      if (message.type === "exec_output" && message.requestId === requestId) {
        output += message.chunk;
        if (!parsed.json) {
          process.stdout.write(message.chunk);
        }
        return;
      }

      if (message.type === "exec_result" && message.requestId === requestId) {
        finalized = true;
        if (parsed.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                requestId,
                exitCode: message.exitCode,
                output,
                startedAt: message.startedAt,
                endedAt: message.endedAt,
                source: message.source ?? null
              },
              null,
              2
            )}\n`
          );
        }

        ws.close(1000, "done");
        process.off("SIGINT", onSigint);
        process.exit(normalizeExitCode(message.exitCode));
      }

      if (message.type === "exec_cancelled" && message.requestId === requestId) {
        finalized = true;
        process.stderr.write(`execution cancelled: ${message.reason ?? "unknown"}\n`);
        ws.close(1000, "done");
        process.off("SIGINT", onSigint);
        process.exit(130);
      }

      if (message.type === "exec_error" && message.requestId === requestId) {
        finalized = true;
        process.stderr.write(`execution failed: ${message.message}\n`);
        ws.close(1000, "done");
        process.off("SIGINT", onSigint);
        process.exit(1);
      }

      if (message.type === "error") {
        finalized = true;
        process.stderr.write(`bridge error [${message.code}]: ${message.message}\n`);
        ws.close(1000, "done");
        process.off("SIGINT", onSigint);
        process.exit(1);
      }
    });

    ws.on("close", () => {
      process.off("SIGINT", onSigint);
      if (!finalized) {
        reject(new Error("connection closed before request was finalized"));
        return;
      }
      resolve();
    });

    ws.on("error", (error) => {
      process.off("SIGINT", onSigint);
      reject(error);
    });

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(stringifyMessage(execPayload));
    } else {
      reject(new Error("websocket is not open"));
    }
  });
}

async function runCancel(options: GlobalOptions, args: string[]): Promise<void> {
  const requestId = args[0];
  if (!requestId) {
    throw new Error("usage: bt cancel <requestId>");
  }

  const ws = await connectCli(options);
  const payload: CancelMessage = {
    type: "cancel",
    requestId,
    reason: "manual_cancel"
  };

  ws.send(stringifyMessage(payload));

  const result = await waitForMessage(
    ws,
    (message) =>
      (message.type === "exec_cancelled" && message.requestId === requestId) ||
      (message.type === "error" && message.requestId === requestId)
  );

  if (!result) {
    throw new Error("cancel request did not receive a response");
  }

  if (result.type === "error") {
    throw new Error(`bridge error [${result.code}] ${result.message}`);
  }

  // eslint-disable-next-line no-console
  console.log(`cancelled request ${requestId}`);
  ws.close(1000, "done");
}

function parseGlobalOptions(argv: string[]): { options: GlobalOptions; remaining: string[] } {
  const remaining: string[] = [];
  const options: GlobalOptions = {
    host: process.env.BT_BRIDGE_HOST ?? "127.0.0.1",
    port: toInt(process.env.BT_BRIDGE_PORT, 17373),
    token: process.env.BT_TOKEN,
    clientId: process.env.BT_CLIENT_ID ?? `cli-${randomUUID()}`
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") {
      options.host = argv[i + 1] ?? options.host;
      i += 1;
      continue;
    }

    if (arg === "--port") {
      options.port = toInt(argv[i + 1], options.port);
      i += 1;
      continue;
    }

    if (arg === "--token") {
      options.token = argv[i + 1] ?? options.token;
      i += 1;
      continue;
    }

    if (arg === "--client-id") {
      options.clientId = argv[i + 1] ?? options.clientId;
      i += 1;
      continue;
    }

    remaining.push(arg);
  }

  return { options, remaining };
}

function parseExecArgs(args: string[]): {
  command: string;
  timeoutMs?: number;
  json: boolean;
  requestId?: string;
} {
  let timeoutMs: number | undefined;
  let json = false;
  let requestId: string | undefined;
  const commandParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--timeout-ms") {
      timeoutMs = toInt(args[i + 1], 120000);
      i += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--request-id") {
      requestId = args[i + 1];
      i += 1;
      continue;
    }

    commandParts.push(arg);
  }

  const command = commandParts.join(" ").trim();
  if (!command) {
    throw new Error("usage: bt exec [--timeout-ms N] [--json] [--request-id ID] <command>");
  }

  return { command, timeoutMs, json, requestId };
}

async function connectCli(options: GlobalOptions): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${options.host}:${options.port}/cli`);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("timed out connecting to bridge"));
    }, 6000);

    const onOpen = (): void => {
      const hello: HelloMessage = {
        type: "hello",
        role: "cli",
        token: options.token,
        clientId: options.clientId,
        protocolVersion: PROTOCOL_VERSION
      };
      ws.send(stringifyMessage(hello));
    };

    const onMessage = (buffer: RawData, isBinary: boolean): void => {
      if (isBinary) {
        return;
      }

      const message = safeParseMessage(buffer.toString("utf8"));
      if (!message) {
        return;
      }

      if (message.type === "hello_ack") {
        clearTimeout(timeout);
        cleanup();
        resolve();
        return;
      }

      if (message.type === "error") {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`bridge error [${message.code}] ${message.message}`));
      }
    };

    const onError = (err: Error): void => {
      clearTimeout(timeout);
      cleanup();
      reject(err);
    };

    const cleanup = (): void => {
      ws.off("open", onOpen);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    ws.once("open", onOpen);
    ws.on("message", onMessage);
    ws.once("error", onError);
  });

  return ws;
}

async function waitForMessage(
  ws: WebSocket,
  predicate: (message: WireMessage) => boolean,
  timeoutMs = 6000
): Promise<WireMessage | null> {
  return new Promise<WireMessage | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for message"));
    }, timeoutMs);

    const onMessage = (buffer: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) {
        return;
      }
      const message = safeParseMessage(buffer.toString("utf8"));
      if (!message) {
        return;
      }
      if (message.type === "ping") {
        const pong: PongMessage = { type: "pong", ts: Date.now() };
        ws.send(stringifyMessage(pong));
        return;
      }
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };

    const onClose = (): void => {
      cleanup();
      resolve(null);
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

function normalizeExitCode(exitCode: number): number {
  if (!Number.isFinite(exitCode)) {
    return 1;
  }
  if (exitCode < 0) {
    return 1;
  }
  if (exitCode > 255) {
    return 255;
  }
  return Math.floor(exitCode);
}

function toInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return parsed;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`Browser Terminal CLI (bt)

Usage:
  bt [--host HOST] [--port PORT] [--token TOKEN] <command>

Commands:
  health
  exec [--timeout-ms N] [--json] [--request-id ID] <command>
  cancel <requestId>

Global options:
  --host <host>         Bridge host (default: 127.0.0.1)
  --port <port>         Bridge port (default: 17373)
  --token <token>       Shared auth token (optional)
  --client-id <id>      Stable client id (optional)
  --help                Show this help
`);
}

void main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
