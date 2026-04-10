export type BillingType = 'quotaBased' | 'payAsYouGo';
export type ProviderStatus = 'ok' | 'error' | 'not_configured' | 'auth_expired';
export declare const DEFAULT_PROVIDER_TIMEOUT_MS = 12000;
export declare function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs?: number): Promise<Response>;
export interface UsageWindow {
    /** Percentage used (0-100) */
    utilization: number;
    /** When this window resets (ISO string or Unix ms) */
    resetsAt?: number;
    /** Human-readable window label (e.g. "5h", "7d", "weekly") */
    label: string;
}
export interface QuotaBasedUsage {
    type: 'quotaBased';
    /** Primary usage percentage (0-100), most relevant window */
    utilization: number;
    /** Individual usage windows */
    windows: UsageWindow[];
    /** Requests remaining (if available) */
    remaining?: number;
    /** Total entitlement (if available) */
    entitlement?: number;
}
export interface PayAsYouGoUsage {
    type: 'payAsYouGo';
    /** Cost utilization as percentage of total credits */
    utilization: number;
    /** Amount used in dollars */
    used: number;
    /** Total credits in dollars */
    total: number;
    /** Remaining credits in dollars */
    remaining: number;
}
export type ProviderUsage = QuotaBasedUsage | PayAsYouGoUsage;
export interface ProviderAccountResult {
    label: string;
    email?: string;
    plan?: string;
    usage: ProviderUsage;
    status: ProviderStatus;
    error?: string;
}
export interface ProviderResult {
    providerId: string;
    providerName: string;
    billingType: BillingType;
    status: ProviderStatus;
    plan?: string;
    usage?: ProviderUsage;
    accounts?: ProviderAccountResult[];
    error?: string;
    fetchedAt: number;
}
export interface UsageProvider {
    id: string;
    name: string;
    billingType: BillingType;
    /** Check if this provider has auth credentials configured */
    isConfigured(): Promise<boolean>;
    /** Fetch current usage data */
    fetchUsage(): Promise<ProviderResult>;
}
//# sourceMappingURL=types.d.ts.map