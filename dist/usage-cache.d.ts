import type { ProviderResult } from './providers/types.js';
export interface UsageCacheEntry {
    results: ProviderResult[];
    fetchedAt: number;
}
export declare function readUsageCache(): UsageCacheEntry | null;
export declare function writeUsageCache(results: ProviderResult[]): void;
export declare function invalidateUsageCache(): void;
//# sourceMappingURL=usage-cache.d.ts.map