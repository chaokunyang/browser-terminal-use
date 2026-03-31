---
name: browser-terminal-use-agent
description: Operate Browser Terminal Use as an execution bridge between local CLI and browser-hosted terminals. Use when Codex needs to run or iterate shell commands in non-local environments through a browser terminal, build cloud-side verifiable execution loops for LLM agents, debug remote runtime issues (GPU, containers, bastion-only networks), or manage daemon/extension binding, timeout, cancel, and optional token hardening.
---

# Browser Terminal Use Agent

## Overview

Use this skill to drive Browser Terminal Use as an agent loop runner: issue commands locally, execute in a bound browser terminal tab, stream output, and use remote exit codes as the control signal for next actions.

Read `references/runbook.md` for concrete command templates and troubleshooting mappings.

## Workflow

1. Start or verify daemon connectivity.
2. Ensure extension and terminal tab are ready, then prove the tab is actually bound with a short smoke probe.
3. Run iterative command loops with explicit timeout and request id.
4. Diagnose failures and recover quickly.
5. Enable token hardening when security requirements increase.

## 1) Start Or Verify Daemon Connectivity

Use global commands:

```bash
browterm-daemon --host 127.0.0.1 --port 17373
browterm health
```

Start daemon on localhost and verify health before running commands.

```bash
curl http://127.0.0.1:17373/v1/health
```

Treat daemon health failure as a hard blocker for agent loops.

## 2) Ensure Extension And Tab Readiness

Load extension from `extension/` in Chrome developer mode.
Configure extension bridge URL as `ws://127.0.0.1:17373/extension`.
Bind the browser terminal tab by clicking extension action once.
Refresh the target terminal tab after extension reload.

Do not treat `browterm health` with `extensionConnected: true` as sufficient evidence that a usable terminal tab exists. Prove tab attachment with a trivial bounded command before any long-running request:

```bash
browterm exec --request-id req-tab-smoke --timeout-ms 15000 --json "printf bt-ready"
```

If the smoke probe does not return the expected sentinel text quickly, stop and treat it as a hard blocker. Common causes are:

- no browser terminal tab is open
- the tab is open but not bound to the extension
- the extension is connected but attached to the wrong tab
- output is only browser or extension telemetry rather than command output

## 3) Run Iterative Agent Loops

Use `exec` as the default operation and keep each step deterministic.

- Provide `--timeout-ms` for bounded execution.
- Provide `--request-id` so cancellation and traceability stay explicit.
- Prefer `--json` when post-processing output in automation.
- Use the command exit code as the branching condition for next agent step.

Example:

```bash
browterm exec --request-id req-env-check --timeout-ms 120000 --json "uname -a"
```

### Hang Detection Rules

- Run a short smoke probe first. Never start a long remote test until that probe succeeds.
- If a trivial probe stays queued, times out, or produces no command output within its timeout window, cancel it and raise an error immediately.
- If output consists only of browser or extension telemetry and not the command's expected stdout, treat that as "tab not actually attached" and fail early.
- For longer commands, do not cancel just because stdout is quiet.
- If a longer command appears hung, first check daemon health and whether a browser terminal tab is still bound.
- Only treat the run as a tab-binding or transport failure when health or tab checks fail, or when output shows only browser or extension telemetry instead of terminal output.

### Quote-Safe Command Rules

These are hard rules, not suggestions. If a command is not quote-safe and stable, do not run it through `browterm exec`. Rewrite it first.

- Never pass multiline commands to `browterm exec`.
- Never use heredoc (`<<EOF`) inside `browterm exec` command strings.
- Never send commands with unbalanced or hard-to-audit quoting.
- Never rely on shell state that is not made explicit in the same command string.
- Always prefer one-line commands joined by `;` or `&&`.
- Always rewrite fragile commands into quote-safe, deterministic forms before execution.
- For generated files, use `printf '%s\n' ... > file` instead of heredoc.
- For JSON payload files, prefer `jq -n '...' > file`.
- If the quoting still looks brittle after one rewrite, stop using inline shell and generate a short script with `printf '%s\n' ... > /tmp/<name>.sh; bash /tmp/<name>.sh`.

Safe patterns:

```bash
browterm exec --request-id req-basic --timeout-ms 120000 --json "hostname; whoami; pwd"

browterm exec --request-id req-json --timeout-ms 120000 --json \
  "jq -n '{input_ids:[1,2,3],stream:false}' > /tmp/req.json; cat /tmp/req.json"

browterm exec --request-id req-script --timeout-ms 120000 --json \
  "printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'echo ok' > /tmp/bt_step.sh; bash /tmp/bt_step.sh"
```

Avoid:

```bash
# Avoid multiline/heredoc payloads inside browterm exec
browterm exec --request-id bad --timeout-ms 120000 --json \
  'cat >/tmp/x <<EOF
line1
EOF'
```

```bash
# Avoid nested or ambiguous quoting that is difficult to audit quickly
browterm exec --request-id bad --timeout-ms 120000 --json \
  "python -c 'print(\"unterminated or fragile shell composition here)\""
```

Cancel stuck or obsolete work by request id:

```bash
browterm cancel req-env-check
```

## 4) Diagnose And Recover

When execution fails, check in order:

1. Daemon process and `/v1/health`.
2. Extension options bridge URL.
3. Bound tab status (rebind if needed).
4. Retry command with debug logging on daemon.

Use error-specific playbooks in `references/runbook.md`.

## 5) Enable Optional Token Hardening

Keep default local setup tokenless for fastest setup.
Enable `--token` on daemon and CLI for stricter local security boundaries.
When enabled, keep daemon, extension options, and CLI token values identical.

## Execution Principles

- Keep one active command per loop step.
- Prefer short, composable commands over long opaque scripts.
- Do not execute a command string you cannot quickly prove is quote-safe and stable.
- Persist request ids in logs for auditability.
- Re-run with focused probes before broad retries.
