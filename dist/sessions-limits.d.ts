import type { AccountRateLimits } from './types.js';
export declare function findLatestSessionRateLimits(options?: {
    sinceMs?: number;
    untilMs?: number;
    sessionsDir?: string;
}): {
    rateLimits: AccountRateLimits;
    eventTs?: number;
    sourceFile: string;
} | null;
//# sourceMappingURL=sessions-limits.d.ts.map