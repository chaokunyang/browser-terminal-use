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
        const startIdx = findStartMarkerIndex(this.buffer, this.markers.start);
        if (startIdx < 0) {
            this.buffer = keepPotentialStartPrefix(this.buffer, this.markers.start);
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
function findStartMarkerIndex(buffer, marker) {
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
function keepPotentialStartPrefix(buffer, marker) {
    const max = Math.min(marker.length - 1, buffer.length);
    for (let size = max; size > 0; size -= 1) {
        const suffix = buffer.slice(buffer.length - size);
        if (marker.startsWith(suffix)) {
            return suffix;
        }
    }
    return "";
}
function isMarkerTerminator(buffer, pos) {
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
//# sourceMappingURL=parser.js.map