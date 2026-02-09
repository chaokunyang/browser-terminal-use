# Browser Terminal Use

Chrome extension + local daemon + CLI for executing commands in a browser-hosted terminal and returning structured output + exit codes to your local macOS terminal.

## What You Get

1. `bt-bridge` daemon on localhost (`ws://127.0.0.1:17373`).
2. Chrome MV3 extension that:
   - binds to your terminal tab,
   - injects wrapped commands,
   - captures streamed output,
   - extracts command exit code with sentinel markers.
3. `bt` CLI that:
   - sends commands,
   - streams output in real time,
   - exits with the remote command return code.

## Repository Layout

- `packages/shared`: protocol contracts + marker wrapper + parser.
- `packages/bridge`: websocket daemon and request queue.
- `packages/cli`: local CLI (`bt`).
- `extension`: Chrome extension (MV3).
- `docs/en/install.md`: install + run guide.

## Quick Start (macOS)

1. Install dependencies and build:

```bash
npm install
npm run build
```

2. Start bridge daemon (use a token in real usage):

```bash
npm run start:bridge -- --token your-shared-token
```

3. Load extension from `extension/` in Chrome:
- open `chrome://extensions`
- enable Developer mode
- click `Load unpacked`
- select `extension/`

4. Open extension options and set:
- Bridge URL: `ws://127.0.0.1:17373/extension`
- Token: same value as daemon token

5. Open your web terminal tab and click the extension toolbar icon once to bind it.

6. Run CLI health check:

```bash
npm run start:cli -- --token your-shared-token health
```

7. Execute a command in the bound browser terminal:

```bash
npm run start:cli -- --token your-shared-token exec "echo hello"
```

## CLI Commands

```bash
bt health
bt exec [--timeout-ms N] [--json] [--request-id ID] "<command>"
bt cancel <requestId>
```

Global options:

```bash
--host <host>       # default 127.0.0.1
--port <port>       # default 17373
--token <token>     # optional but recommended
--client-id <id>    # stable ID for cross-session cancel
```

## Design Notes

1. Exit code is captured by wrapping each command with unique markers:
   - `__BT_START_<id>__`
   - `__BT_RC_<id>__:<code>`
   - `__BT_END_<id>__`
2. Extension captures output primarily from page websocket traffic.
3. DOM mutation capture is a fallback if websocket capture is unavailable.
4. Bridge serializes execution requests (single active command) for deterministic behavior.

## Security Baseline

1. Daemon binds to localhost only.
2. Optional token auth for extension + CLI handshake.
3. Extension requires explicit tab binding for reliable target control.

## Known Limitations

1. Browser terminal implementations vary; websocket encoding may be proprietary in some products.
2. Some terminal UIs may block synthetic keyboard input fallback.
3. Cross-origin iframe terminals can reduce observability depending on page constraints.
4. Truly interactive TUIs are not fully supported (current model is command-oriented, not full PTY mirroring).

## Validation

- Build: `npm run build`
- Test: `npm run test`
- Type check: `npm run lint`

All pass in this repository state.
