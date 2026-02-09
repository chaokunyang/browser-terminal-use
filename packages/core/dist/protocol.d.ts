export declare const PROTOCOL_VERSION = 1;
export type ClientRole = "cli" | "extension";
export interface HelloMessage {
    type: "hello";
    role: ClientRole;
    token?: string;
    clientId?: string;
    protocolVersion: number;
}
export interface HelloAckMessage {
    type: "hello_ack";
    role: ClientRole;
    protocolVersion: number;
    serverTime: number;
}
export interface ErrorMessage {
    type: "error";
    code: string;
    message: string;
    requestId?: string;
}
export interface ExecMessage {
    type: "exec";
    requestId: string;
    command: string;
    timeoutMs?: number;
}
export interface CancelMessage {
    type: "cancel";
    requestId: string;
    reason?: string;
}
export interface HealthMessage {
    type: "health";
}
export interface HealthResultMessage {
    type: "health_result";
    extensionConnected: boolean;
    queuedCount: number;
    activeRequestId: string | null;
    uptimeMs: number;
    serverTime: number;
}
export interface QueuedMessage {
    type: "queued";
    requestId: string;
    position: number;
}
export interface ExecRequestMessage {
    type: "exec_request";
    requestId: string;
    command: string;
    timeoutMs: number;
    createdAt: number;
}
export interface ExecCancelMessage {
    type: "exec_cancel";
    requestId: string;
    reason?: string;
}
export interface ExecStartedMessage {
    type: "exec_started";
    requestId: string;
    startedAt: number;
}
export interface ExecOutputMessage {
    type: "exec_output";
    requestId: string;
    chunk: string;
    source?: string;
}
export interface ExecResultMessage {
    type: "exec_result";
    requestId: string;
    exitCode: number;
    output: string;
    source?: string;
    startedAt: number;
    endedAt: number;
}
export interface ExecErrorMessage {
    type: "exec_error";
    requestId: string;
    message: string;
}
export interface ExecCancelledMessage {
    type: "exec_cancelled";
    requestId: string;
    reason?: string;
}
export interface TerminalStatusMessage {
    type: "terminal_status";
    terminalCount: number;
    activeTabId: number | null;
    boundTabId: number | null;
    tabIds: number[];
    url?: string;
}
export interface PingMessage {
    type: "ping";
    ts: number;
}
export interface PongMessage {
    type: "pong";
    ts: number;
}
export type BridgeInboundMessage = HelloMessage | ExecMessage | CancelMessage | HealthMessage | ExecStartedMessage | ExecOutputMessage | ExecResultMessage | ExecErrorMessage | ExecCancelledMessage | TerminalStatusMessage | PongMessage;
export type BridgeOutboundMessage = HelloAckMessage | ErrorMessage | QueuedMessage | HealthResultMessage | ExecRequestMessage | ExecCancelMessage | ExecStartedMessage | ExecOutputMessage | ExecResultMessage | ExecErrorMessage | ExecCancelledMessage | PingMessage;
export type WireMessage = BridgeInboundMessage | BridgeOutboundMessage;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function safeParseMessage(raw: string): WireMessage | null;
export declare function stringifyMessage(message: WireMessage): string;
