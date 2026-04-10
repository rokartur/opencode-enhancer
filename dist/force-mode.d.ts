export interface ForceState {
    forcedAlias: string | null;
    forcedUntil: number | null;
    previousRotationStrategy: string | null;
    forcedBy: string | null;
}
export declare function getForceState(): ForceState;
export declare function isForceActive(): boolean;
export declare function activateForce(alias: string, actor?: string): {
    success: boolean;
    error?: string;
    state?: ForceState;
};
export declare function clearForce(): {
    success: boolean;
    restoredStrategy?: string | null;
};
export declare function checkAndAutoClearForce(): {
    wasCleared: boolean;
    reason?: string;
};
export declare function getRemainingForceTimeMs(): number;
export declare function formatForceDuration(ms: number): string;
//# sourceMappingURL=force-mode.d.ts.map