export interface Markers {
    id: string;
    start: string;
    rcPrefix: string;
    end: string;
}
export declare function normalizeMarkerId(requestId: string): string;
export declare function buildMarkers(requestId: string): Markers;
export declare function buildWrappedCommand(command: string, markers: Markers): string;
