import type { Markers } from "./markers.js";

export interface MarkerParseFeedResult {
  chunks: string[];
  started: boolean;
  completed: boolean;
  exitCode: number | null;
}

type ParseState = "awaiting_start" | "capturing" | "done";

export class MarkerParser {
  private readonly markers: Markers;
  private state: ParseState = "awaiting_start";
  private buffer = "";
  private exitCode: number | null = null;
  private captured = "";

  constructor(markers: Markers) {
    this.markers = markers;
  }

  feed(chunk: string): MarkerParseFeedResult {
    if (this.state === "done") {
      return this.snapshot([]);
    }

    this.buffer += chunk;
    const emitted: string[] = [];

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

  private maybeTransitionToCapturing(): void {
    if (this.state !== "awaiting_start") {
      return;
    }

    const startIdx = findStartMarkerIndex(this.buffer, this.markers.start);
    if (startIdx < 0) {
      this.buffer = keepPotentialStartPrefix(this.buffer, this.markers.start);
      return;
    }

    this.buffer = trimSingleLeadingNewline(
      this.buffer.slice(startIdx + this.markers.start.length)
    );
    this.state = "capturing";
  }

  private emitCleaned(input: string, emitted: string[]): void {
    if (input.length === 0) {
      return;
    }

    const cleaned = this.stripRcMarker(input);
    if (cleaned.length === 0) {
      return;
    }

    emitted.push(cleaned);
    this.captured += cleaned;
  }

  private stripRcMarker(input: string): string {
    const escaped = escapeRegex(this.markers.rcPrefix);
    const regex = new RegExp(`${escaped}(-?\\d+)`, "g");

    return input.replace(regex, (_match, rcText: string) => {
      const parsed = Number.parseInt(rcText, 10);
      if (!Number.isNaN(parsed)) {
        this.exitCode = parsed;
      }
      return "";
    });
  }

  private holdbackLength(): number {
    return Math.max(this.markers.end.length, this.markers.rcPrefix.length + 16, 32);
  }

  private snapshot(chunks: string[]): MarkerParseFeedResult {
    return {
      chunks,
      started: this.state !== "awaiting_start",
      completed: this.state === "done",
      exitCode: this.exitCode
    };
  }

  getState(): ParseState {
    return this.state;
  }

  getExitCode(): number | null {
    return this.exitCode;
  }

  getOutput(): string {
    return this.captured;
  }
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimSingleLeadingNewline(input: string): string {
  if (input.startsWith("\r\n")) {
    return input.slice(2);
  }
  if (input.startsWith("\n") || input.startsWith("\r")) {
    return input.slice(1);
  }
  return input;
}

function findStartMarkerIndex(buffer: string, marker: string): number {
  let from = 0;
  while (true) {
    const idx = buffer.indexOf(marker, from);
    if (idx < 0) {
      return -1;
    }

    const afterPos = idx + marker.length;
    if (afterPos >= buffer.length) {
      return -1;
    }

    if (isMarkerTerminator(buffer, afterPos)) {
      return idx;
    }

    from = idx + 1;
  }
}

function keepPotentialStartPrefix(buffer: string, marker: string): string {
  const max = Math.min(marker.length - 1, buffer.length);
  for (let size = max; size > 0; size -= 1) {
    const suffix = buffer.slice(buffer.length - size);
    if (marker.startsWith(suffix)) {
      return suffix;
    }
  }
  return "";
}

function isMarkerTerminator(buffer: string, pos: number): boolean {
  const ch = buffer[pos];
  if (!ch) {
    return false;
  }
  if (ch === "\n" || ch === "\r") {
    return true;
  }
  if (ch === "\\" && pos + 1 < buffer.length) {
    const esc = buffer[pos + 1];
    if (esc === "n" || esc === "r") {
      const next = buffer[pos + 2] ?? "";
      if (next === "'") {
        return false;
      }
      return true;
    }
  }
  const code = ch.charCodeAt(0);
  return code >= 0 && code <= 0x1f;
}
