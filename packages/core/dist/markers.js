export function normalizeMarkerId(requestId) {
    return requestId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || "req";
}
export function buildMarkers(requestId) {
    const id = normalizeMarkerId(requestId);
    return {
        id,
        start: `__BT_START_${id}__`,
        rcPrefix: `__BT_RC_${id}__:`,
        end: `__BT_END_${id}__`
    };
}
export function buildWrappedCommand(command, markers) {
    const normalized = command.trimEnd();
    const body = normalized.length > 0 ? normalized : ":";
    return [
        `printf '${markers.start}\\n'`,
        `( ${body} )`,
        "__bt_rc=$?",
        `printf '${markers.rcPrefix}%s\\n' \"$__bt_rc\"`,
        `printf '${markers.end}\\n'`
    ].join("; ");
}
//# sourceMappingURL=markers.js.map