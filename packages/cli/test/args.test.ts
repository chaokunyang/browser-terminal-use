import { describe, expect, it } from "vitest";
import { normalizeExitCode, parseExecArgs, parseGlobalOptions } from "../src/args.js";

describe("parseGlobalOptions", () => {
  it("uses environment defaults", () => {
    const env: NodeJS.ProcessEnv = {
      BT_BRIDGE_HOST: "10.0.0.8",
      BT_BRIDGE_PORT: "18888",
      BT_TOKEN: "env-token",
      BT_CLIENT_ID: "env-client"
    };

    const parsed = parseGlobalOptions(["exec", "uname", "-a"], env, "generated-id");

    expect(parsed.options).toEqual({
      host: "10.0.0.8",
      port: 18888,
      token: "env-token",
      clientId: "env-client"
    });
    expect(parsed.remaining).toEqual(["exec", "uname", "-a"]);
  });

  it("prefers argv over environment", () => {
    const env: NodeJS.ProcessEnv = {
      BT_BRIDGE_HOST: "10.0.0.8",
      BT_BRIDGE_PORT: "18888",
      BT_TOKEN: "env-token",
      BT_CLIENT_ID: "env-client"
    };

    const parsed = parseGlobalOptions(
      [
        "--host",
        "127.0.0.1",
        "--port",
        "17373",
        "--token",
        "arg-token",
        "--client-id",
        "arg-client",
        "health"
      ],
      env,
      "generated-id"
    );

    expect(parsed.options).toEqual({
      host: "127.0.0.1",
      port: 17373,
      token: "arg-token",
      clientId: "arg-client"
    });
    expect(parsed.remaining).toEqual(["health"]);
  });

  it("uses generated client id when env is missing", () => {
    const parsed = parseGlobalOptions(["health"], {}, "generated-id");
    expect(parsed.options.clientId).toBe("generated-id");
  });
});

describe("parseExecArgs", () => {
  it("parses flags and command", () => {
    const parsed = parseExecArgs([
      "--timeout-ms",
      "15000",
      "--json",
      "--request-id",
      "req-1",
      "uname",
      "-a"
    ]);

    expect(parsed).toEqual({
      command: "uname -a",
      timeoutMs: 15000,
      json: true,
      requestId: "req-1"
    });
  });

  it("falls back timeout to default when invalid", () => {
    const parsed = parseExecArgs(["--timeout-ms", "oops", "ls"]);
    expect(parsed.timeoutMs).toBe(120000);
    expect(parsed.command).toBe("ls");
  });

  it("throws when command is missing", () => {
    expect(() => parseExecArgs(["--json"])).toThrow(
      "usage: browterm exec [--timeout-ms N] [--json] [--request-id ID] <command>"
    );
  });
});

describe("normalizeExitCode", () => {
  it("normalizes non-finite and negative values", () => {
    expect(normalizeExitCode(Number.NaN)).toBe(1);
    expect(normalizeExitCode(-1)).toBe(1);
  });

  it("clamps and floors values", () => {
    expect(normalizeExitCode(7.9)).toBe(7);
    expect(normalizeExitCode(999)).toBe(255);
  });
});
