export interface BridgeRuntimeConfig {
    host: string;
    port: number;
    token?: string;
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    pingIntervalMs: number;
    logLevel: "info" | "debug";
}
export declare function parseBridgeConfig(argv: string[], env?: NodeJS.ProcessEnv): BridgeRuntimeConfig;
