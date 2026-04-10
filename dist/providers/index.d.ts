import type { ProviderResult, UsageProvider } from './types.js';
/** All registered providers in display order */
export declare const allProviders: UsageProvider[];
/** Get a provider by ID */
export declare function getProvider(id: string): UsageProvider | undefined;
/** Fetch usage from all providers in parallel with a per-provider timeout */
export declare function fetchAllUsage(opts?: {
    providerIds?: string[];
    timeoutMs?: number;
}): Promise<ProviderResult[]>;
export type { ProviderResult, UsageProvider } from './types.js';
//# sourceMappingURL=index.d.ts.map