export interface GlobalOptions {
  host: string;
  port: number;
  token?: string;
  clientId: string;
}

export interface ParsedGlobalOptions {
  options: GlobalOptions;
  remaining: string[];
}

export interface ParsedExecArgs {
  command: string;
  timeoutMs?: number;
  json: boolean;
  requestId?: string;
}

export function parseGlobalOptions(
  argv: string[],
  env: NodeJS.ProcessEnv,
  defaultClientId: string
): ParsedGlobalOptions {
  const remaining: string[] = [];
  const options: GlobalOptions = {
    host: env.BT_BRIDGE_HOST ?? "127.0.0.1",
    port: toInt(env.BT_BRIDGE_PORT, 17373),
    token: env.BT_TOKEN,
    clientId: env.BT_CLIENT_ID ?? defaultClientId
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

export function parseExecArgs(args: string[]): ParsedExecArgs {
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
    throw new Error(
      "usage: browterm exec [--timeout-ms N] [--json] [--request-id ID] <command>"
    );
  }

  return { command, timeoutMs, json, requestId };
}

export function normalizeExitCode(exitCode: number): number {
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
