// Shared types for multi-provider usage checking

export type BillingType = "quotaBased" | "payAsYouGo";

export type ProviderStatus = "ok" | "error" | "not_configured" | "auth_expired";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 12_000;

export function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  const mergedInit: RequestInit = { ...init, signal };
  return fetch(url, mergedInit);
}

export interface UsageWindow {
  /** Percentage used (0-100) */
  utilization: number;
  /** When this window resets (ISO string or Unix ms) */
  resetsAt?: number;
  /** Human-readable window label (e.g. "5h", "7d", "weekly") */
  label: string;
  /** Requests/credits remaining within this window (if available) */
  remaining?: number;
  /** Total entitlement within this window (if available) */
  entitlement?: number;
  /** Whether paid overage / extra budget is enabled for this window */
  extraBudgetEnabled?: boolean;
  /** Configured paid overage / extra budget amount (if exposed by the provider) */
  extraBudgetTotal?: number;
  /** Amount already spent / consumed from paid overage / extra budget */
  extraBudgetUsed?: number;
}

export interface QuotaBasedUsage {
  type: "quotaBased";
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
  type: "payAsYouGo";
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
