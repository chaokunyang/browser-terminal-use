# Browser Terminal Use Runbook

## Quick Start

```bash
browterm-daemon --host 127.0.0.1 --port 17373
browterm health
browterm exec --request-id req-smoke --timeout-ms 120000 "echo ok"
```

## Agent Loop Template

Use this pattern for every loop iteration:

```bash
browterm exec --request-id <req-id> --timeout-ms <ms> --json "<command>"
```

Recommended defaults:

- `req-id`: short stable id like `req-env-001`.
- `timeout-ms`: `120000` for most checks; raise only when required.
- `--json`: keep on when machine parsing output.

## Optional Security Hardening

Enable token on daemon:

```bash
browterm-daemon --host 127.0.0.1 --port 17373 --token <shared-token>
```

Run CLI with same token:

```bash
browterm --token <shared-token> exec --request-id req-secure --timeout-ms 120000 "whoami"
```

## Failure Mapping

`execution failed: extension is not connected`

- Verify daemon is running.
- Verify extension bridge URL is `ws://127.0.0.1:17373/extension`.
- Re-open extension page to wake service worker.

`no terminal tab available`

- Open target browser terminal tab.
- Click extension action to bind the tab.
- Refresh tab and retry.

Command hangs or no output

- Rebind tab and retry once.
- Start daemon with `--debug` and inspect logs.
- Reduce command scope and test with a minimal probe.

## Non-Local Environment Debugging Pattern

Use the tool to iterate quickly in complex remote contexts:

- Cloud GPU runtime mismatch checks.
- Container or cluster environment drift checks.
- Bastion-only network environment validation.

Example staged probes:

```bash
browterm exec --request-id req-host --timeout-ms 60000 "uname -a"
browterm exec --request-id req-env --timeout-ms 60000 "env | sort | head -n 40"
browterm exec --request-id req-gpu --timeout-ms 60000 "nvidia-smi || true"
```
