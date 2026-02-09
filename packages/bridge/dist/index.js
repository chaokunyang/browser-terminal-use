#!/usr/bin/env node
import { parseBridgeConfig } from "./config.js";
import { BridgeServer } from "./server.js";
async function main() {
    if (process.argv.includes("--help")) {
        printHelp();
        return;
    }
    const config = parseBridgeConfig(process.argv.slice(2));
    const server = new BridgeServer(config);
    await server.start();
    const shutdown = async () => {
        await server.stop();
        process.exit(0);
    };
    process.on("SIGINT", () => {
        void shutdown();
    });
    process.on("SIGTERM", () => {
        void shutdown();
    });
}
function printHelp() {
    // eslint-disable-next-line no-console
    console.log(`browterm-daemon

Usage:
  browterm-daemon [--host 127.0.0.1] [--port 17373] [--token <token>] [--debug]

Options:
  --host <host>                  Bind host (default: 127.0.0.1)
  --port <port>                  Bind port (default: 17373)
  --token <token>                Optional shared token for CLI+extension auth
  --default-timeout-ms <ms>      Default request timeout (default: 120000)
  --max-timeout-ms <ms>          Maximum timeout allowed (default: 600000)
  --ping-interval-ms <ms>        Ping interval (default: 15000)
  --debug                        Enable debug logs
  --help                         Show this help
`);
}
void main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[bridge:fatal] ${String(err)}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map