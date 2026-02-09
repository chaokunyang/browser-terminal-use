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
2. Ensure extension and terminal tab are ready.
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
- Persist request ids in logs for auditability.
- Re-run with focused probes before broad retries.
