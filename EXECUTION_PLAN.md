# Execution Plan: Chrome Extension + Local Client for Browser Terminal Automation (macOS)

## 1. Goal and Scope

Build a system that allows a local terminal client (on macOS) to:
1. send commands to a server terminal that is rendered inside Chrome,
2. capture complete terminal output,
3. capture command return code (exit status),
4. receive structured results programmatically.

This plan targets Chrome extension MV3 and a local bridge process on macOS.

---

## 2. Success Criteria

A command is considered successful when all are true:
1. command is delivered to the browser terminal reliably,
2. output stream is captured without truncation,
3. final exit code is extracted correctly,
4. result is returned to the local client in a machine-readable format,
5. command timeout/cancel behavior is deterministic,
6. only authorized local callers can control execution.

---

## 3. High-Level Architecture

## Components
1. **Chrome Extension (MV3)**
   - Content script attached to terminal page.
   - Background service worker for routing/control.
   - Optional side panel/options page for diagnostics.

2. **Terminal Adapter (inside content script)**
   - Detects terminal implementation (xterm.js, custom DOM terminal, canvas/WebGL renderer).
   - Injects keystrokes/commands.
   - Subscribes to terminal output stream.
   - Parses command boundary markers + exit code markers.

3. **Local Bridge Daemon (macOS)**
   - Runs on localhost.
   - Maintains authenticated channel with extension.
   - Exposes local API (Unix socket or localhost TCP) for CLI client.

4. **CLI Client (local terminal)**
   - `send-command`, `stream`, `cancel`, `health` commands.
   - Prints stdout/stderr stream and exits with remote return code.

## Data Flow
1. CLI sends command request to local bridge.
2. Bridge forwards request to extension.
3. Extension content script injects command into browser terminal.
4. Content script captures output until end-marker is detected.
5. Content script returns `{stdout, stderr(optional), exitCode, metadata}`.
6. Bridge relays result to CLI; CLI exits with same code.

---

## 4. Critical Early Decision: Extension–Local Bridge Transport

Choose one transport before implementation:

## Option A (Recommended): WebSocket on `127.0.0.1`
- Extension opens WebSocket client to local bridge (`ws://127.0.0.1:<port>`).
- Pros: easy debugging, language-agnostic daemon, simple CLI integration.
- Cons: service worker lifetime handling in MV3; requires heartbeat/reconnect.

## Option B: Chrome Native Messaging
- Extension connects to native messaging host.
- Pros: Chrome-supported local app channel with explicit allowlist.
- Cons: packaging and install complexity; JSON stdio protocol constraints.

## Recommendation
Start with **Option A** for fastest iteration, then optionally migrate to Native Messaging for hardened deployment.

---

## 5. Terminal-Side Feasibility Spike (Do First)

Before full build, verify terminal observability on target site.

## Tasks
1. Inspect page terminal technology in DevTools:
   - xterm.js DOM/canvas?
   - iframe/shadow DOM?
   - direct input element or custom key handlers?
2. Validate that keystrokes can be injected (simulate typing + Enter).
3. Validate that output can be observed in near real time.
4. Validate detection of command completion marker.

## Output of spike
A short technical note with:
- target selectors / DOM anchors,
- event injection method that works,
- output capture hook that works,
- known blockers (CSP, cross-origin iframe, canvas-only rendering).

**Go/No-Go gate:** proceed only after spike confirms at least one reliable output hook.

---

## 6. Command Protocol Design

Because browser terminals usually do not expose native process exit code directly, use wrapped commands with unique sentinels.

## Request schema
```json
{
  "requestId": "uuid",
  "command": "ls -la",
  "timeoutMs": 120000,
  "cwd": null,
  "env": {}
}
```

## Execution wrapping strategy
For POSIX shell:
1. Generate unique markers per request, e.g. `__CMD_START_<id>__`, `__CMD_END_<id>__`, `__RC_<id>__`.
2. Send wrapped command:
   - print start marker,
   - run user command,
   - print return code marker,
   - print end marker.

Example wrapper concept:
```bash
printf '__CMD_START_<id>__\n';
( <user command> );
rc=$?;
printf '__RC_<id>__:%s\n' "$rc";
printf '__CMD_END_<id>__\n';
```

## Parsing rules
1. Ignore preamble until start marker.
2. Capture all bytes/lines between start and end markers.
3. Parse `__RC_<id>__:<n>` as final return code.
4. Strip ANSI optionally for machine output, keep raw stream for logs.

---

## 7. Extension Implementation Plan (MV3)

## Phase 1: Scaffold
1. Create `manifest.json` (MV3) with:
   - `permissions`: `storage`, `tabs`, `scripting`.
   - `host_permissions`: terminal domain(s), localhost bridge origin.
2. Add background service worker.
3. Add content script matching terminal URL.
4. Add options page for local bridge URL + auth token.

## Phase 2: Content Script Terminal Adapter
1. Build adapter interface:
   - `connect()`, `sendInput(text)`, `onOutput(cb)`, `isReady()`.
2. Implement adapter for detected terminal technology from spike.
3. Add output buffering and marker parser state machine.
4. Implement single-flight execution first (one active command).

## Phase 3: Background Orchestration
1. Maintain connection to local bridge.
2. Route command requests to active terminal tab.
3. Correlate by `requestId`.
4. Return progress events and final result.

## Phase 4: Robustness
1. Reconnect logic for bridge disconnect.
2. Tab reload/reopen recovery.
3. Timeout + cancel (send Ctrl+C sequence).
4. Backpressure handling for large output.

---

## 8. Local Bridge Daemon Plan (macOS)

## Responsibilities
1. Accept CLI requests.
2. Authenticate local callers.
3. Forward requests to extension.
4. Stream output events and final result.
5. Keep command lifecycle state.

## API shape (suggested)
1. `POST /v1/exec` -> returns `requestId`.
2. `GET /v1/stream/:requestId` (SSE/WebSocket) -> output chunks/status.
3. `POST /v1/cancel/:requestId`.
4. `GET /v1/health`.

## Security baseline
1. Bind to `127.0.0.1` only.
2. Require bearer token or local socket ACL.
3. Reject oversized payloads.
4. Audit-log command origin and timestamps.

---

## 9. CLI Client Plan

## Commands
1. `bt exec "<cmd>"` - run command and print output.
2. `bt exec --json "<cmd>"` - emit structured JSON result.
3. `bt cancel <requestId>`.
4. `bt health`.

## Behavior
1. Stream output to local stdout in real time.
2. Exit process with remote exit code.
3. On timeout, emit clear reason and non-zero code.
4. Preserve raw mode option for interactive follow-up (future phase).

---

## 10. Security and Compliance Plan

1. Explicitly scope extension host permissions to exact domains.
2. Require user action to bind active tab as controllable terminal tab.
3. Use per-session auth token between bridge and extension.
4. Implement allowlist/denylist for commands if needed.
5. Redact sensitive tokens in logs.
6. Provide kill switch: disable extension control instantly.
7. Document risk: this is remote command execution; treat as privileged channel.

---

## 11. Reliability and Edge Cases

1. **Prompt noise / async logs:** marker-based parsing avoids prompt heuristics.
2. **Large outputs:** chunked streaming + max buffer cap.
3. **Terminal color/ANSI:** store raw + cleaned outputs separately.
4. **Concurrent commands:** start single-flight; add queue later.
5. **Network drops:** reconnect with resume where feasible.
6. **Cross-origin iframe terminals:** may require `all_frames` script injection or impossible if blocked.
7. **Canvas/WebGL rendering:** fallback to websocket interception if DOM text unavailable.

---

## 12. Test Strategy

## Unit tests
1. Marker parser state machine.
2. Exit code extraction.
3. Timeout/cancel logic.
4. Output chunk ordering.

## Integration tests
1. Mock terminal page + extension command injection.
2. Bridge <-> extension transport handshake.
3. CLI end-to-end command roundtrip.

## Manual tests (real target)
1. Simple command: `echo hello` -> rc 0.
2. Failing command: `false` -> rc 1.
3. Large output: `seq 1 20000`.
4. Timeout path: `sleep 999` with timeout.
5. Cancel path: long-running command + Ctrl+C.

## Acceptance test matrix
- Chrome stable on macOS.
- Fresh browser session.
- Terminal tab reload.
- Bridge restart mid-command.

---

## 13. Delivery Milestones

## Milestone 0: Feasibility Spike (1-2 days)
- terminal technology confirmed,
- proof of input + output hook,
- blockers identified.

## Milestone 1: MVP (3-5 days)
- extension + bridge + CLI basic roundtrip,
- wrapped command execution,
- stdout + exit code returned,
- single active command.

## Milestone 2: Hardened Beta (4-7 days)
- reconnect logic,
- timeout/cancel,
- auth + permission hardening,
- integration tests.

## Milestone 3: Production Readiness (3-5 days)
- packaging/scripts for macOS setup,
- observability + error taxonomy,
- operator docs and runbook.

---

## 14. Implementation Backlog (Prioritized)

1. Build feasibility spike script and document findings.
2. Initialize MV3 extension skeleton.
3. Implement terminal adapter (input + output hooks).
4. Implement marker wrapper + parser.
5. Implement local bridge WebSocket server.
6. Implement CLI `exec` with streamed output.
7. Add timeout/cancel flow.
8. Add auth and permission hardening.
9. Add automated tests.
10. Add packaging and docs.

---

## 15. Operational Runbook (Initial)

1. Start local bridge daemon.
2. Load unpacked extension in Chrome.
3. Open target browser terminal and bind tab.
4. Run `bt health` to verify connectivity.
5. Run `bt exec "echo ok"` and verify output + rc.
6. Inspect logs if command stalls (bridge, extension, tab).

---

## 16. Risks and Mitigations

1. **Terminal rendering not introspectable**
   - Mitigation: inspect underlying websocket/pty traffic via injected hooks if legal/possible.
2. **MV3 service worker suspension breaks transport**
   - Mitigation: heartbeat + reconnect; optionally offscreen document.
3. **Marker collisions with user output**
   - Mitigation: cryptographically random marker IDs.
4. **Sensitive command leakage**
   - Mitigation: local-only transport + token auth + log redaction.
5. **Site updates break selectors/hooks**
   - Mitigation: adapter abstraction + health diagnostics.

---

## 17. Suggested Tech Stack

1. Extension: TypeScript + Vite (or Plasmo) + MV3.
2. Bridge: Node.js (fast iteration) or Go (single binary deployment).
3. CLI: same language as bridge for shared protocol models.
4. Tests: Vitest/Jest for parser + Playwright (extension E2E) + integration harness.

---

## 18. Definition of Done

1. `bt exec "echo hello"` returns `hello` and exits `0`.
2. `bt exec "false"` returns empty output and exits `1`.
3. Large output does not truncate unexpectedly.
4. Cancel and timeout are deterministic.
5. Restarting bridge/Chrome can recover without reinstall.
6. Security controls (localhost bind + token + scoped host permissions) are enforced.
7. Setup + troubleshooting docs are complete.
