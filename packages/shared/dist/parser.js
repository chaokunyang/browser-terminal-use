export class MarkerParser {
    markers;
    state = "awaiting_start";
    buffer = "";
    exitCode = null;
    captured = "";
    constructor(markers) {
        this.markers = markers;
    }
    feed(chunk) {
        if (this.state === "done") {
            return this.snapshot([]);
        }
        this.buffer += chunk;
        const emitted = [];
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
    maybeTransitionToCapturing() {
        if (this.state !== "awaiting_start") {
            return;
        }
        const startIdx = this.buffer.indexOf(this.markers.start);
        if (startIdx < 0) {
            const keep = Math.max(this.markers.start.length - 1, 0);
            if (this.buffer.length > keep) {
                this.buffer = this.buffer.slice(this.buffer.length - keep);
            }
            return;
        }
        this.buffer = trimSingleLeadingNewline(this.buffer.slice(startIdx + this.markers.start.length));
        this.state = "capturing";
    }
    emitCleaned(input, emitted) {
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
    stripRcMarker(input) {
        const escaped = escapeRegex(this.markers.rcPrefix);
        const regex = new RegExp(`${escaped}(-?\\d+)`, "g");
        return input.replace(regex, (_match, rcText) => {
            const parsed = Number.parseInt(rcText, 10);
            if (!Number.isNaN(parsed)) {
                this.exitCode = parsed;
            }
            return "";
        });
    }
    holdbackLength() {
        return Math.max(this.markers.end.length, this.markers.rcPrefix.length + 16, 32);
    }
    snapshot(chunks) {
        return {
            chunks,
            started: this.state !== "awaiting_start",
            completed: this.state === "done",
            exitCode: this.exitCode
        };
    }
    getState() {
        return this.state;
    }
    getExitCode() {
        return this.exitCode;
    }
    getOutput() {
        return this.captured;
    }
}
function escapeRegex(input) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function trimSingleLeadingNewline(input) {
    if (input.startsWith("\r\n")) {
        return input.slice(2);
    }
    if (input.startsWith("\n") || input.startsWith("\r")) {
        return input.slice(1);
    }
    return input;
}
//# sourceMappingURL=parser.js.map