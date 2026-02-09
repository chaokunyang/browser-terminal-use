# @browser-terminal-use/cli

CLI client for Browser Terminal Use.

This package exposes `browterm`, which sends commands to a running bridge daemon
and prints streamed output from the bound browser terminal tab.

## Install

```bash
npm i -g @browser-terminal-use/cli
```

Or run directly:

```bash
npx @browser-terminal-use/cli --help
```

## Usage

```bash
browterm [--host HOST] [--port PORT] [--token TOKEN] <command>
```

## Commands

```text
health
exec [--timeout-ms N] [--json] [--request-id ID] <command>
cancel <requestId>
```

## Global options

```text
--host <host>         Bridge host (default: 127.0.0.1)
--port <port>         Bridge port (default: 17373)
--token <token>       Shared auth token (optional)
--client-id <id>      Stable client id (optional)
--help                Show help
```

## Examples

```bash
browterm --token your-token health
browterm --token your-token exec "uname -a"
browterm --token your-token exec --timeout-ms 30000 --json "ls -la"
browterm --token your-token cancel <requestId>
```

## Exit behavior

- On success, `browterm exec` exits with the same code as the remote shell command.
- On timeout/cancel/error, it exits with a non-zero status.

## Notes

- Requires a running `@browser-terminal-use/bridge` daemon.
- Requires the Browser Terminal Use Chrome extension connected to the daemon.
