import { describe, expect, it } from "vitest";
import { buildMarkers, buildWrappedCommand } from "../src/markers.js";
import { MarkerParser } from "../src/parser.js";

describe("marker command wrapper", () => {
  it("includes marker lines and command", () => {
    const markers = buildMarkers("abc-123");
    const wrapped = buildWrappedCommand("echo hello", markers);
    expect(wrapped).toContain(markers.start);
    expect(wrapped).toContain(markers.rcPrefix);
    expect(wrapped).toContain(markers.end);
    expect(wrapped).toContain("echo hello");
  });
});

describe("marker parser", () => {
  it("captures output and rc across chunks", () => {
    const markers = buildMarkers("request-id");
    const parser = new MarkerParser(markers);

    const feed1 = parser.feed(`noise\n${markers.start}\nhel`);
    expect(feed1.started).toBe(true);
    expect(feed1.completed).toBe(false);

    const feed2 = parser.feed(`lo\n${markers.rcPrefix}7\n${markers.end}\n`);
    expect(feed2.completed).toBe(true);
    expect(parser.getExitCode()).toBe(7);
    expect(parser.getOutput()).toContain("hello");
  });

  it("handles inline end marker without trailing newline", () => {
    const markers = buildMarkers("x");
    const parser = new MarkerParser(markers);
    parser.feed(`${markers.start}\nabc`);
    const result = parser.feed(`${markers.rcPrefix}0${markers.end}`);
    expect(result.completed).toBe(true);
    expect(parser.getExitCode()).toBe(0);
    expect(parser.getOutput()).toBe("abc");
  });

  it("captures markers when stream text starts directly with marker", () => {
    const markers = buildMarkers("json-case");
    const parser = new MarkerParser(markers);

    const first = parser.feed(`${markers.start}hello `);
    expect(first.started).toBe(true);
    expect(first.completed).toBe(false);

    const second = parser.feed(`world${markers.rcPrefix}0${markers.end}`);
    expect(second.completed).toBe(true);
    expect(parser.getExitCode()).toBe(0);
    expect(parser.getOutput()).toContain("hello world");
  });

  it("ignores echoed command text that contains marker literals", () => {
    const markers = buildMarkers("echo-case");
    const parser = new MarkerParser(markers);

    parser.feed(
      `$printf '${markers.start}\\\\n'; ( ls ); __bt_rc=$?; printf '${markers.rcPrefix}%s\\\\n' \"$__bt_rc\"; printf '${markers.end}\\\\n'\\n`
    );

    const result = parser.feed(
      `${markers.start}\nfile-a\n${markers.rcPrefix}0\n${markers.end}\n`
    );

    expect(result.completed).toBe(true);
    expect(parser.getExitCode()).toBe(0);
    expect(parser.getOutput()).toContain("file-a");
    expect(parser.getOutput()).not.toContain("__bt_rc");
  });
});
