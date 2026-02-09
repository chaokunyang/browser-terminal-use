export interface Markers {
  id: string;
  start: string;
  rcPrefix: string;
  end: string;
}

export function normalizeMarkerId(requestId: string): string {
  return requestId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || "req";
}

export function buildMarkers(requestId: string): Markers {
  const id = normalizeMarkerId(requestId);
  return {
    id,
    start: `__BT_START_${id}__`,
    rcPrefix: `__BT_RC_${id}__:`,
    end: `__BT_END_${id}__`
  };
}

export function buildWrappedCommand(command: string, markers: Markers): string {
  const normalized = command.trimEnd();
  return [
    `printf '${markers.start}\\n'`,
    normalized.length > 0 ? normalized : ":",
    "__bt_rc=$?",
    `printf '${markers.rcPrefix}%s\\n' \"$__bt_rc\"`,
    `printf '${markers.end}\\n'`
  ].join("\n");
}
