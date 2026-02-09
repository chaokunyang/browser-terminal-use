export interface GlobalOptions {
    host: string;
    port: number;
    token?: string;
    clientId: string;
}
export interface ParsedGlobalOptions {
    options: GlobalOptions;
    remaining: string[];
}
export interface ParsedExecArgs {
    command: string;
    timeoutMs?: number;
    json: boolean;
    requestId?: string;
}
export declare function parseGlobalOptions(argv: string[], env: NodeJS.ProcessEnv, defaultClientId: string): ParsedGlobalOptions;
export declare function parseExecArgs(args: string[]): ParsedExecArgs;
export declare function normalizeExitCode(exitCode: number): number;
