import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/config.js";

describe("parseBridgeConfig", () => {
  it("uses built-in defaults", () => {
    const config = parseBridgeConfig([], {});
    expect(config).toEqual({
      host: "127.0.0.1",
      port: 17373,
      token: undefined,
      defaultTimeoutMs: 120000,
      maxTimeoutMs: 600000,
      pingIntervalMs: 15000,
      logLevel: "info"
    });
  });

  it("loads values from env and allows argv override", () => {
    const env: NodeJS.ProcessEnv = {
      BT_BRIDGE_HOST: "0.0.0.0",
      BT_BRIDGE_PORT: "19000",
      BT_TOKEN: "env-token",
      BT_DEFAULT_TIMEOUT_MS: "30000",
      BT_MAX_TIMEOUT_MS: "90000",
      BT_PING_INTERVAL_MS: "20000",
      BT_LOG_LEVEL: "debug"
    };

    const config = parseBridgeConfig(
      ["--host", "127.0.0.1", "--port", "17373", "--token", "arg-token"],
      env
    );

    expect(config).toEqual({
      host: "127.0.0.1",
      port: 17373,
      token: "arg-token",
      defaultTimeoutMs: 30000,
      maxTimeoutMs: 90000,
      pingIntervalMs: 20000,
      logLevel: "debug"
    });
  });

  it("enables debug with flag", () => {
    const config = parseBridgeConfig(["--debug"], {});
    expect(config.logLevel).toBe("debug");
  });

  it("validates port range", () => {
    expect(() => parseBridgeConfig(["--port", "0"], {})).toThrow("Invalid port: 0");
    expect(() => parseBridgeConfig(["--port", "70000"], {})).toThrow(
      "Invalid port: 70000"
    );
  });

  it("validates timeout bounds", () => {
    expect(() => parseBridgeConfig(["--default-timeout-ms", "999"], {})).toThrow(
      "default-timeout-ms must be >= 1000"
    );
    expect(() =>
      parseBridgeConfig(
        ["--default-timeout-ms", "10000", "--max-timeout-ms", "9999"],
        {}
      )
    ).toThrow("max-timeout-ms must be >= default-timeout-ms");
  });
});
