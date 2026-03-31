# Browser Terminal Use Runbook

## Quick Start

```bash
browterm-daemon --host 127.0.0.1 --port 17373
browterm health
browterm exec --request-id req-tab-smoke --timeout-ms 15000 --json "printf bt-ready"
```

Expected result:

- exit code `0`
- stdout contains `bt-ready`

If this probe hangs, stays queued, times out, or emits only browser telemetry, stop. Do not start a long remote command yet.

## Agent Loop Template

Use this pattern for every loop iteration:

```bash
browterm exec --request-id <req-id> --timeout-ms <ms> --json "<command>"
```

Recommended defaults:

- `req-id`: short stable id like `req-env-001`.
- `timeout-ms`: `120000` for most checks; raise only when required.
- `--json`: keep on when machine parsing output.
- Treat quote safety as mandatory. If the command string is brittle, multiline, or hard to audit, rewrite it before execution.

Mandatory command-construction policy:

- Never pass multiline commands to `browterm exec`.
- Never use heredoc inside a `browterm exec` command string.
- Never send a command string with ambiguous nested quoting if a simpler equivalent exists.
- Always prefer one-line commands joined by `;` or `&&`.
- Always prefer deterministic file generation with `printf '%s\n' ... > file` or `jq -n '...' > file`.
- If a command still looks fragile after one rewrite, emit a short temporary script with `printf`, then execute that script.

Mandatory preflight before long-running work:

```bash
browterm health
browterm exec --request-id req-tab-smoke --timeout-ms 15000 --json "printf bt-ready"
```

Interpretation:

- `extensionConnected: true` only means the extension can talk to the daemon.
- It does not prove a bound browser terminal tab exists.
- A successful smoke probe is the required proof of usable tab attachment.

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

`extensionConnected: true` but smoke probe times out, stays queued, or prints only telemetry

- Treat this as a missing or wrong tab binding, not as a slow remote command.
- Cancel the request id.
- Open the intended browser terminal tab.
- Rebind via extension action.
- Refresh the tab.
- Re-run the smoke probe.
- Raise an error early if the smoke probe still fails.

Command hangs or no output

- If this is a trivial smoke probe, fail immediately and diagnose tab binding.
- If this is a longer command, do not cancel it solely because it is quiet.
- First run `browterm health` and verify the daemon is healthy.
- Then verify the browser terminal tab is still open and bound to the extension.
- Rebind and refresh only if those checks show the tab attachment is broken.
- Start daemon with `--debug` and inspect logs.
- Reduce command scope and test with a minimal probe.

No-progress policy

- Smoke probe: no expected stdout within `15s` is a hard failure.
- Normal command: quiet stdout alone is not a failure signal.
- For a suspected hang, check daemon health and tab binding before deciding the run is broken.
- Treat telemetry-only output, lost daemon health, or missing tab binding as the failure signals for remote attachment problems.
- Do not keep polling a request when tab attachment is unproven.

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

Quote-safe file/script patterns:

```bash
browterm exec --request-id req-json --timeout-ms 120000 --json \
  "jq -n '{input_ids:[1,2,3],stream:false}' > /tmp/req.json; cat /tmp/req.json"

browterm exec --request-id req-script --timeout-ms 120000 --json \
  "printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'echo ok' > /tmp/bt_step.sh; bash /tmp/bt_step.sh"
```

Unsafe patterns to reject:

```bash
browterm exec --request-id bad --timeout-ms 120000 --json \
  'cat >/tmp/x <<EOF
line1
EOF'
```
