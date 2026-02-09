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
    if (this.getState() === "done") {
      return this.snapshot([]);
    }

    this.buffer += chunk;
    const emitted: string[] = [];

    while (true) {
      if (this.getState() === "done") {
        break;
      }
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx < 0) {
        if (this.state === "capturing") {
          this.tryInlineMarkers(emitted);
        }
        break;
      }

      const lineWithNl = this.buffer.slice(0, newlineIdx + 1);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      const maybeChunk = this.processLine(lineWithNl);
      if (maybeChunk.length > 0) {
        emitted.push(maybeChunk);
        this.captured += maybeChunk;
      }
    }

    return this.snapshot(emitted);
  }

  private tryInlineMarkers(emitted: string[]): void {
    if (this.state !== "capturing") {
      return;
    }

    const endIdx = this.buffer.indexOf(this.markers.end);
    if (endIdx < 0) {
      return;
    }

    const before = this.buffer.slice(0, endIdx);
    const cleaned = this.stripRcMarker(before);
    if (cleaned.length > 0) {
      emitted.push(cleaned);
      this.captured += cleaned;
    }

    this.buffer = this.buffer.slice(endIdx + this.markers.end.length);
    this.state = "done";
  }

  private processLine(rawLine: string): string {
    if (this.state === "awaiting_start") {
      const startIdx = rawLine.indexOf(this.markers.start);
      if (startIdx < 0) {
        return "";
      }
      this.state = "capturing";
      const after = trimSingleLeadingNewline(rawLine.slice(startIdx + this.markers.start.length));
      return this.stripRcMarker(after);
    }

    if (this.state !== "capturing") {
      return "";
    }

    const endIdx = rawLine.indexOf(this.markers.end);
    if (endIdx >= 0) {
      const before = rawLine.slice(0, endIdx);
      const cleaned = this.stripRcMarker(before);
      this.state = "done";
      return cleaned;
    }

    return this.stripRcMarker(rawLine);
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
