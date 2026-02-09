import type { Markers } from "./markers.js";
export interface MarkerParseFeedResult {
    chunks: string[];
    started: boolean;
    completed: boolean;
    exitCode: number | null;
}
type ParseState = "awaiting_start" | "capturing" | "done";
export declare class MarkerParser {
    private readonly markers;
    private state;
    private buffer;
    private exitCode;
    private captured;
    constructor(markers: Markers);
    feed(chunk: string): MarkerParseFeedResult;
    private tryInlineMarkers;
    private processLine;
    private stripRcMarker;
    private snapshot;
    getState(): ParseState;
    getExitCode(): number | null;
    getOutput(): string;
}
export {};
