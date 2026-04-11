// Z.AI coding plan usage provider
// Quota: GET https://api.z.ai/api/monitor/usage/quota/limit
// Auth: raw key in Authorization header (no Bearer prefix)
import { getApiKey, hasCredential } from "./auth.js";
import { fetchWithTimeout } from "./types.js";
const QUOTA_ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";
const AUTH_KEY = "zai-coding-plan";
function getZaiPlan(level) {
    if (typeof level !== "string")
        return undefined;
    const trimmed = level.trim();
    return trimmed || undefined;
}
function getZaiWindowLabel(limit) {
    if (limit.type === "TOKENS_LIMIT" && limit.unit === 3 && limit.number === 5) {
        return "5h";
    }
    if (limit.type === "TOKENS_LIMIT" && limit.unit === 6) {
        return "weekly";
    }
    if (limit.type === "TIME_LIMIT") {
        return "time";
    }
    return limit.type || "quota";
}
export const zaiProvider = {
    id: "zai",
    name: "Z.AI",
    billingType: "quotaBased",
    async isConfigured() {
        return hasCredential(AUTH_KEY);
    },
    async fetchUsage() {
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
        try {
            const res = await fetchWithTimeout(QUOTA_ENDPOINT, {
                headers: { Authorization: apiKey }, // No Bearer prefix
            });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                return {
                    providerId: this.id,
                    providerName: this.name,
                    billingType: this.billingType,
                    status: res.status === 401 || res.status === 403 ? "auth_expired" : "error",
                    error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
                    fetchedAt: Date.now(),
                };
            }
            const json = (await res.json());
            const limits = json.data?.limits || [];
            const windows = [];
            let maxUtilization = 0;
            for (const limit of limits) {
                const utilization = limit.percentage;
                const entitlement = limit.total ??
                    (limit.remaining !== undefined ? limit.currentValue + limit.remaining : undefined);
                const remaining = limit.remaining ??
                    (typeof entitlement === "number"
                        ? Math.max(0, entitlement - limit.currentValue)
                        : undefined);
                windows.push({
                    utilization,
                    resetsAt: limit.nextResetTime ? new Date(limit.nextResetTime).getTime() : undefined,
                    label: getZaiWindowLabel(limit),
                    remaining,
                    entitlement,
                });
                maxUtilization = Math.max(maxUtilization, utilization);
            }
            return {
                providerId: this.id,
                providerName: this.name,
                billingType: this.billingType,
                status: "ok",
                plan: getZaiPlan(json.data?.level),
                usage: {
                    type: "quotaBased",
                    utilization: maxUtilization,
                    windows,
                },
                fetchedAt: Date.now(),
            };
        }
        catch (err) {
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
//# sourceMappingURL=zai.js.map