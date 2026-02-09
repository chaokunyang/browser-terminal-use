# @browser-terminal-use/core

<p align="center">
  <img src="https://raw.githubusercontent.com/chaokunyang/browser-terminal-use/aa9e7888f2d8e33728caf83a236d65426f301cf1/assets/logo/browser-terminal-use-logo.svg" alt="Browser Terminal Use logo" width="760" />
</p>

Shared protocol and parsing primitives for Browser Terminal Use.

This package contains:

- Wire message types and JSON helpers.
- Command marker generation and wrapped command builder.
- Streaming parser that extracts output and exit code by marker boundaries.

## Install

```bash
npm i @browser-terminal-use/core
```

## API

### Protocol helpers

```ts
import {
  PROTOCOL_VERSION,
  safeParseMessage,
  stringifyMessage,
  type WireMessage
} from "@browser-terminal-use/core";
```

### Marker helpers

```ts
import { buildMarkers, buildWrappedCommand } from "@browser-terminal-use/core";

const markers = buildMarkers("req-123");
const wrapped = buildWrappedCommand("uname -a", markers);
```

`buildWrappedCommand` wraps user commands with:

- `__BT_START_<id>__`
- `__BT_RC_<id>__:<exitCode>`
- `__BT_END_<id>__`

### Streaming parser

```ts
import { MarkerParser, buildMarkers } from "@browser-terminal-use/core";

const parser = new MarkerParser(buildMarkers("req-123"));

const feed1 = parser.feed("__BT_START_req123__\nhello\n");
const feed2 = parser.feed("__BT_RC_req123__:0\n__BT_END_req123__\n");

console.log(feed1.chunks); // ["hello\n"]
console.log(feed2.exitCode); // 0
console.log(parser.getOutput()); // "hello\n"
```

## Notes

- Designed for incremental stream parsing.
- Parser tolerates fragmented chunk boundaries.
- Node.js 20+ is recommended.
