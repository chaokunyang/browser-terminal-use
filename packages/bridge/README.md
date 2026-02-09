# @browser-terminal-use/bridge

Local daemon for Browser Terminal Use.

This package exposes `browterm-daemon`, a WebSocket bridge that:

- accepts CLI requests,
- dispatches execution requests to the Chrome extension,
- streams output back to clients,
- returns final exit code and execution result.

## Install

```bash
npm i -g @browser-terminal-use/bridge
```

Or run without global install:

```bash
npx @browser-terminal-use/bridge --help
```

## Usage

```bash
browterm-daemon --host 127.0.0.1 --port 17373 --token your-token
```

## CLI options

```text
--host <host>                  Bind host (default: 127.0.0.1)
--port <port>                  Bind port (default: 17373)
--token <token>                Optional shared token for CLI+extension auth
--default-timeout-ms <ms>      Default request timeout (default: 120000)
--max-timeout-ms <ms>          Maximum timeout allowed (default: 600000)
--ping-interval-ms <ms>        Ping interval (default: 15000)
--debug                        Enable debug logs
--help                         Show help
```

## Environment variables

```text
BT_BRIDGE_HOST
BT_BRIDGE_PORT
BT_TOKEN
BT_DEFAULT_TIMEOUT_MS
BT_MAX_TIMEOUT_MS
BT_PING_INTERVAL_MS
BT_LOG_LEVEL
```

## Endpoints

- WebSocket: `ws://<host>:<port>/cli`
- WebSocket: `ws://<host>:<port>/extension`
- HTTP health: `http://<host>:<port>/v1/health`

## Notes

- The daemon processes one execution request at a time to keep terminal state deterministic.
- Use a token in production-like setups.
- Pair this package with `@browser-terminal-use/cli` and the Browser Terminal Use Chrome extension.
