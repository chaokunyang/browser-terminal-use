export const PROTOCOL_VERSION = 1;
export function isRecord(value) {
    return typeof value === "object" && value !== null;
}
export function safeParseMessage(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed) || typeof parsed.type !== "string") {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
export function stringifyMessage(message) {
    return JSON.stringify(message);
}
//# sourceMappingURL=protocol.js.map