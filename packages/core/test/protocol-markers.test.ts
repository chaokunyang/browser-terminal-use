import { describe, expect, it } from "vitest";
import {
  buildMarkers,
  buildWrappedCommand,
  normalizeMarkerId,
  safeParseMessage,
  stringifyMessage,
  type HelloMessage
} from "../src/index.js";

describe("marker utilities", () => {
  it("normalizes marker id by stripping non-alphanumeric characters", () => {
    expect(normalizeMarkerId("req-1_abcd!@#$")).toBe("req1abcd");
  });

  it("truncates long marker ids to 24 chars", () => {
    expect(normalizeMarkerId("abcdefghijklmnopqrstuvwxyz123456")).toHaveLength(24);
  });

  it("falls back to req for empty marker id", () => {
    expect(normalizeMarkerId("----")).toBe("req");
  });

  it("uses no-op body when wrapped command is empty", () => {
    const markers = buildMarkers("id");
    const wrapped = buildWrappedCommand("   ", markers);
    expect(wrapped).toContain("( : )");
  });
});

describe("protocol helpers", () => {
  it("parses valid messages", () => {
    const raw = JSON.stringify({ type: "ping", ts: 1 });
    const parsed = safeParseMessage(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("ping");
  });

  it("returns null for malformed or invalid payloads", () => {
    expect(safeParseMessage("{nope")).toBeNull();
    expect(safeParseMessage(JSON.stringify({ foo: "bar" }))).toBeNull();
    expect(safeParseMessage(JSON.stringify("x"))).toBeNull();
  });

  it("stringifies wire messages", () => {
    const hello: HelloMessage = {
      type: "hello",
      role: "cli",
      protocolVersion: 1
    };
    expect(stringifyMessage(hello)).toBe(
      "{\"type\":\"hello\",\"role\":\"cli\",\"protocolVersion\":1}"
    );
  });
});
