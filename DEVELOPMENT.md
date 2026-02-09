# Development Commands

This file is for repository development workflows.

## Prerequisites

- Node.js 20+
- npm 10+

## Install

```bash
npm install
```

## Build / Test / Lint

```bash
npm run build
npm run test
npm run lint
```

## Run from Repository

Start local daemon via workspace build output:

```bash
npm run start:browterm-daemon -- --host 127.0.0.1 --port 17373
```

Run CLI via workspace build output:

```bash
npm run start:browterm -- health
npm run start:browterm -- exec "uname -a"
npm run start:browterm -- exec --json "ls -la"
npm run start:browterm -- cancel <requestId>
```

## Dev Watch Commands

```bash
npm run dev:bridge
npm run dev:cli
```

## Package Dry Run

```bash
npm pack --dry-run --workspace @browser-terminal-use/core
npm pack --dry-run --workspace @browser-terminal-use/bridge
npm pack --dry-run --workspace @browser-terminal-use/cli
```
