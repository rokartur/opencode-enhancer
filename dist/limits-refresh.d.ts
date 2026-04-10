import type { AccountCredentials } from './types.js';
export interface LimitRefreshResult {
    alias: string;
    updated: boolean;
    error?: string;
}
export declare function refreshRateLimitsForAccount(account: AccountCredentials): Promise<LimitRefreshResult>;
export declare function refreshRateLimits(accounts: AccountCredentials[], alias?: string): Promise<LimitRefreshResult[]>;
//# sourceMappingURL=limits-refresh.d.ts.map