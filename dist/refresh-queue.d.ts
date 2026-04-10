import { type LimitRefreshResult } from './limits-refresh.js';
import type { AccountCredentials } from './types.js';
export interface RefreshQueueState {
    running: boolean;
    startedAt: number;
    finishedAt?: number;
    total: number;
    completed: number;
    errors: number;
    currentAlias?: string;
    currentAliases: string[];
    active: number;
    concurrency: number;
    stopRequested: boolean;
    stopped: boolean;
    results: LimitRefreshResult[];
}
export declare function getRefreshQueueState(): RefreshQueueState | null;
export declare function stopRefreshQueue(): void;
export declare function startRefreshQueue(accounts: AccountCredentials[], alias?: string): RefreshQueueState;
//# sourceMappingURL=refresh-queue.d.ts.map