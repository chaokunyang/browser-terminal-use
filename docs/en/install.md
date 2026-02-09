# Install and Run (macOS + Chrome)

## 1. Prerequisites

1. macOS with Node.js 20+ (tested with Node 22).
2. Google Chrome (Developer mode enabled for extension loading).
3. Access to the target browser terminal page.

## 2. Build

From repo root:

```bash
npm install
npm run build
```

## 3. Start Local Bridge Daemon

Run daemon on localhost:

```bash
npm run start:bridge -- --host 127.0.0.1 --port 17373 --token your-shared-token
```

Optional flags:

```bash
--default-timeout-ms 120000
--max-timeout-ms 600000
--ping-interval-ms 15000
--debug
```

Health endpoint:

```bash
curl http://127.0.0.1:17373/v1/health
```

## 4. Load Chrome Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository `extension/` directory.

## 5. Configure Extension

1. Open extension options page.
2. Set:
   - **Bridge URL**: `ws://127.0.0.1:17373/extension`
   - **Auth Token**: same token used in daemon startup.
3. Save.

## 6. Bind Terminal Tab

1. Open your web terminal page in Chrome.
2. Click the extension icon once.
3. This sets the current tab as the preferred execution target.

## 7. Use CLI

Health check:

```bash
npm run start:cli -- --token your-shared-token health
```

Execute command:

```bash
npm run start:cli -- --token your-shared-token exec "uname -a"
```

JSON mode:

```bash
npm run start:cli -- --token your-shared-token exec --json "ls -la"
```

Cancel running request:

```bash
npm run start:cli -- --token your-shared-token cancel <requestId>
```

## 8. Expected Behavior

1. CLI streams terminal output in real-time.
2. CLI exits with the same return code as remote command.
3. Bridge queues requests and runs one command at a time.

## 9. Troubleshooting

### `execution failed: extension is not connected`
- Verify daemon is running.
- Verify extension options URL/token.
- Ensure extension service worker is active (open extensions page if needed).

### `no terminal tab available`
- Open terminal tab.
- Click extension icon to bind tab.

### Command hangs or no output
- Terminal may use unsupported websocket protocol/encoding.
- Try rebinding tab and rerun.
- Enable daemon `--debug` and inspect logs.

### Output contains marker fragments
- This indicates parser could not cleanly isolate marker boundaries from terminal stream framing.
- Re-run once; if persistent, tune wrapper/parser for that terminal vendor's framing format.
