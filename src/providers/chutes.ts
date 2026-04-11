// Chutes AI usage provider
// Profile: GET https://api.chutes.ai/users/me
// Quotas: GET https://api.chutes.ai/users/me/quotas
// Usage: GET https://api.chutes.ai/users/me/quota_usage/{chute_id}
// Auth: raw key in Authorization header (no Bearer prefix)

import { getApiKey, hasCredential } from "./auth.js";
import { fetchWithTimeout } from "./types.js";
import type { ProviderResult, UsageProvider, UsageWindow } from "./types.js";

const AUTH_KEY = "chutes";
const BASE_URL = "https://api.chutes.ai";

interface ChutesQuota {
  chute_id: string;
  is_default: boolean;
  quota: number;
  payment_refresh_date: string;
}

interface ChutesQuotaUsage {
  quota: number;
  used: number;
}

export const chutesProvider: UsageProvider = {
  id: "chutes",
  name: "Chutes AI",
  billingType: "quotaBased",

  async isConfigured(): Promise<boolean> {
    return hasCredential(AUTH_KEY);
  },

  async fetchUsage(): Promise<ProviderResult> {
    const apiKey = getApiKey(AUTH_KEY);
    if (!apiKey) {
      return {
        providerId: this.id,
        providerName: this.name,
        billingType: this.billingType,
        status: "not_configured",
        fetchedAt: Date.now(),
      };
    }

    const headers = { Authorization: apiKey }; // No Bearer prefix

    try {
      // Fetch quotas
      const quotasRes = await fetchWithTimeout(`${BASE_URL}/users/me/quotas`, { headers });

      if (!quotasRes.ok) {
        const text = await quotasRes.text().catch(() => "");
        return {
          providerId: this.id,
          providerName: this.name,
          billingType: this.billingType,
          status: quotasRes.status === 401 || quotasRes.status === 403 ? "auth_expired" : "error",
          error: `HTTP ${quotasRes.status}: ${text.slice(0, 200)}`,
          fetchedAt: Date.now(),
        };
      }

      const quotas = (await quotasRes.json()) as ChutesQuota[];
      const defaultQuota = quotas.find((q) => q.is_default) || quotas[0];

      if (!defaultQuota) {
        return {
          providerId: this.id,
          providerName: this.name,
          billingType: this.billingType,
          status: "ok",
          usage: { type: "quotaBased", utilization: 0, windows: [] },
          fetchedAt: Date.now(),
        };
      }

      // Fetch usage for the default quota
      const usageRes = await fetchWithTimeout(
        `${BASE_URL}/users/me/quota_usage/${defaultQuota.chute_id}`,
        { headers },
      );

      const windows: UsageWindow[] = [];
      let utilization = 0;

      if (usageRes.ok) {
        const usage = (await usageRes.json()) as ChutesQuotaUsage;
        utilization = usage.quota > 0 ? (usage.used / usage.quota) * 100 : 0;
        const remaining = usage.quota > 0 ? Math.max(0, usage.quota - usage.used) : undefined;
        windows.push({
          utilization,
          resetsAt: defaultQuota.payment_refresh_date
            ? new Date(defaultQuota.payment_refresh_date).getTime()
            : undefined,
          label: "monthly",
          remaining,
          entitlement: usage.quota,
        });
      }

      return {
        providerId: this.id,
        providerName: this.name,
        billingType: this.billingType,
        status: "ok",
        usage: {
          type: "quotaBased",
          utilization,
          remaining: defaultQuota.quota
            ? Math.max(0, defaultQuota.quota - (utilization * defaultQuota.quota) / 100)
            : undefined,
          entitlement: defaultQuota.quota,
          windows,
        },
        fetchedAt: Date.now(),
      };
    } catch (err) {
      return {
        providerId: this.id,
        providerName: this.name,
        billingType: this.billingType,
        status: "error",
        error: `${err}`,
        fetchedAt: Date.now(),
      };
    }
  },
};
