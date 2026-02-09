export interface BridgeRuntimeConfig {
  host: string;
  port: number;
  token?: string;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  pingIntervalMs: number;
  logLevel: "info" | "debug";
}

const DEFAULTS: BridgeRuntimeConfig = {
  host: "127.0.0.1",
  port: 17373,
  token: undefined,
  defaultTimeoutMs: 120000,
  maxTimeoutMs: 600000,
  pingIntervalMs: 15000,
  logLevel: "info"
};

export function parseBridgeConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): BridgeRuntimeConfig {
  const out: BridgeRuntimeConfig = {
    host: env.BT_BRIDGE_HOST ?? DEFAULTS.host,
    port: toInt(env.BT_BRIDGE_PORT, DEFAULTS.port),
    token: env.BT_TOKEN ?? DEFAULTS.token,
    defaultTimeoutMs: toInt(env.BT_DEFAULT_TIMEOUT_MS, DEFAULTS.defaultTimeoutMs),
    maxTimeoutMs: toInt(env.BT_MAX_TIMEOUT_MS, DEFAULTS.maxTimeoutMs),
    pingIntervalMs: toInt(env.BT_PING_INTERVAL_MS, DEFAULTS.pingIntervalMs),
    logLevel: env.BT_LOG_LEVEL === "debug" ? "debug" : "info"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") {
      out.host = argv[i + 1] ?? out.host;
      i += 1;
      continue;
    }
    if (arg === "--port") {
      out.port = toInt(argv[i + 1], out.port);
      i += 1;
      continue;
    }
    if (arg === "--token") {
      out.token = argv[i + 1] ?? out.token;
      i += 1;
      continue;
    }
    if (arg === "--default-timeout-ms") {
      out.defaultTimeoutMs = toInt(argv[i + 1], out.defaultTimeoutMs);
      i += 1;
      continue;
    }
    if (arg === "--max-timeout-ms") {
      out.maxTimeoutMs = toInt(argv[i + 1], out.maxTimeoutMs);
      i += 1;
      continue;
    }
    if (arg === "--ping-interval-ms") {
      out.pingIntervalMs = toInt(argv[i + 1], out.pingIntervalMs);
      i += 1;
      continue;
    }
    if (arg === "--debug") {
      out.logLevel = "debug";
      continue;
    }
  }

  if (!Number.isFinite(out.port) || out.port <= 0 || out.port > 65535) {
    throw new Error(`Invalid port: ${out.port}`);
  }

  if (out.defaultTimeoutMs < 1000) {
    throw new Error("default-timeout-ms must be >= 1000");
  }

  if (out.maxTimeoutMs < out.defaultTimeoutMs) {
    throw new Error("max-timeout-ms must be >= default-timeout-ms");
  }

  return out;
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return parsed;
}
