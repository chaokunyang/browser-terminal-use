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
npm run start:browterm-daemon -- --host 127.0.0.1 --port 17373 --token your-shared-token
```

Run CLI via workspace build output:

```bash
npm run start:browterm -- --token your-shared-token health
npm run start:browterm -- --token your-shared-token exec "uname -a"
npm run start:browterm -- --token your-shared-token exec --json "ls -la"
npm run start:browterm -- --token your-shared-token cancel <requestId>
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
