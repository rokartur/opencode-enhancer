// GitHub Copilot usage provider
// Fetches plan info and quota from /copilot_internal/user API
// which returns premium_interactions entitlement, remaining, and plan type.
// Endpoint 1: GET https://api.github.com/user (user identity)
// Endpoint 2: GET https://api.github.com/copilot_internal/user (quota + plan)
import { getOAuthToken, hasCredential } from "./auth.js";
import { fetchWithTimeout } from "./types.js";
const AUTH_KEY = "github-copilot";
const USER_ENDPOINT = "https://api.github.com/user";
const COPILOT_INTERNAL_ENDPOINT = "https://api.github.com/copilot_internal/user";
function parseQuotaResetDate(raw) {
    if (!raw)
        return undefined;
    try {
        const d = new Date(raw);
        return isNaN(d.getTime()) ? undefined : d.getTime();
    }
    catch {
        return undefined;
    }
}
function formatPlanName(plan) {
    if (!plan)
        return "Unknown";
    const map = {
        individual_pro: "Individual Pro",
        individual_free: "Individual Free",
        business: "Business",
        enterprise: "Enterprise",
    };
    return map[plan] || plan.charAt(0).toUpperCase() + plan.slice(1).replace(/_/g, " ");
}
export const copilotProvider = {
    id: "copilot",
    name: "GitHub Copilot",
    billingType: "quotaBased",
    async isConfigured() {
        return hasCredential(AUTH_KEY);
    },
    async fetchUsage() {
        const token = getOAuthToken(AUTH_KEY);
        if (!token) {
            return {
                providerId: this.id,
                providerName: this.name,
                billingType: this.billingType,
                status: "not_configured",
                fetchedAt: Date.now(),
            };
        }
        const ghHeaders = {
            Authorization: `token ${token}`,
            Accept: "application/json",
            "User-Agent": "opencode-enhancer",
            "X-GitHub-Api-Version": "2022-11-28",
        };
        try {
            // Fetch user identity and copilot plan/quota in parallel
            const [userRes, copilotRes] = await Promise.allSettled([
                fetchWithTimeout(USER_ENDPOINT, { headers: ghHeaders }),
                fetchWithTimeout(COPILOT_INTERNAL_ENDPOINT, {
                    headers: {
                        ...ghHeaders,
                        "Editor-Version": "vscode/1.96.2",
                        "X-GitHub-Api-Version": "2025-04-01",
                    },
                }),
            ]);
            // Parse user identity
            let login = "unknown";
            if (userRes.status === "fulfilled" && userRes.value.ok) {
                try {
                    const user = (await userRes.value.json());
                    login = user.login || "unknown";
                }
                catch {
                    /* ignore */
                }
            }
            const userAuthFailed = userRes.status === "fulfilled" &&
                (userRes.value.status === 401 || userRes.value.status === 403);
            if (userAuthFailed) {
                return {
                    providerId: this.id,
                    providerName: this.name,
                    billingType: this.billingType,
                    status: "auth_expired",
                    error: `HTTP ${userRes.value.status}`,
                    fetchedAt: Date.now(),
                };
            }
            // Parse copilot internal response
            let copilotData;
            let copilotError;
            if (copilotRes.status === "fulfilled") {
                if (copilotRes.value.ok) {
                    try {
                        copilotData = (await copilotRes.value.json());
                    }
                    catch {
                        copilotError = "Invalid JSON from copilot_internal/user";
                    }
                }
                else {
                    const status = copilotRes.value.status;
                    if (status === 404) {
                        // Plan doesn't have Copilot at all — this is not an error, just no Copilot
                        copilotError = "No Copilot subscription";
                    }
                    else if (status === 401 || status === 403) {
                        copilotError = "Auth failed for copilot_internal/user";
                    }
                    else {
                        const text = await copilotRes.value.text().catch(() => "");
                        copilotError = `HTTP ${status}: ${text.slice(0, 100)}`;
                    }
                }
            }
            else {
                copilotError = `${copilotRes.reason}`;
            }
            // Build result
            const plan = copilotData?.copilot_plan || copilotData?.plan;
            const planLabel = formatPlanName(plan);
            const windows = [];
            let utilization = 0;
            let remaining;
            let entitlement;
            let overagePermitted = false;
            let isUnlimited = false;
            if (copilotData?.quota_snapshots) {
                // Prefer premium_interactions, then sum all snapshots
                const snapshots = copilotData.quota_snapshots;
                const premium = snapshots.premium_interactions ??
                    snapshots.premium_requests ??
                    snapshots.premium ??
                    Object.values(Object.fromEntries(Object.entries(snapshots).filter(([k]) => k.includes("premium"))))[0];
                const chat = snapshots.chat;
                const completions = snapshots.completions;
                if (premium) {
                    // Premium interactions is the authoritative quota for individual pro plans
                    if (premium.unlimited) {
                        isUnlimited = true;
                    }
                    else {
                        entitlement = premium.entitlement ?? 0;
                        const premiumsRemaining = premium.remaining ?? 0;
                        overagePermitted = !!premium.overage_permitted;
                        // If remaining is negative, user is in overage
                        if (premiumsRemaining < 0) {
                            utilization =
                                entitlement > 0
                                    ? ((entitlement + Math.abs(premiumsRemaining)) / entitlement) * 100
                                    : 100;
                        }
                        else if (entitlement > 0) {
                            utilization = ((entitlement - premiumsRemaining) / entitlement) * 100;
                        }
                        remaining = Math.max(0, premiumsRemaining);
                    }
                    windows.push({
                        utilization: isUnlimited
                            ? 0
                            : premium.remaining !== undefined
                                ? premium.remaining < 0
                                    ? 100
                                    : Math.round((((premium.entitlement ?? 0) - premium.remaining) /
                                        (premium.entitlement || 1)) *
                                        100)
                                : Math.round(utilization),
                        label: `premium${plan ? ` (${planLabel})` : ""}`,
                        resetsAt: parseQuotaResetDate(copilotData.quota_reset_date_utc ||
                            copilotData.quota_reset_date ||
                            copilotData.limited_user_reset_date),
                        remaining,
                        entitlement,
                    });
                }
                else {
                    // Sum all snapshot categories
                    let totalEntitlement = 0;
                    let totalRemaining = 0;
                    let anyUnlimited = false;
                    for (const [, snap] of Object.entries(snapshots)) {
                        if (snap.unlimited) {
                            anyUnlimited = true;
                        }
                        if (snap.entitlement !== undefined && snap.entitlement > 0) {
                            totalEntitlement += snap.entitlement;
                            if (snap.remaining !== undefined) {
                                totalRemaining += snap.remaining;
                            }
                        }
                    }
                    if (anyUnlimited && totalEntitlement === 0) {
                        isUnlimited = true;
                        utilization = 0;
                    }
                    else if (totalEntitlement > 0) {
                        const used = totalRemaining < 0
                            ? totalEntitlement + Math.abs(totalRemaining)
                            : totalEntitlement - totalRemaining;
                        utilization = totalEntitlement > 0 ? (used / totalEntitlement) * 100 : 0;
                        entitlement = totalEntitlement;
                        remaining = Math.max(0, totalRemaining);
                    }
                    windows.push({
                        utilization: Math.round(utilization),
                        label: plan ? `(${planLabel})` : "quota",
                        resetsAt: parseQuotaResetDate(copilotData.quota_reset_date_utc ||
                            copilotData.quota_reset_date ||
                            copilotData.limited_user_reset_date),
                        remaining,
                        entitlement,
                    });
                }
            }
            else if (copilotData?.monthly_quotas) {
                // Legacy monthly_quotas format
                const mq = copilotData.monthly_quotas;
                entitlement = (mq.completions ?? 0) + (mq.chat ?? 0);
                remaining = entitlement; // No remaining info in legacy format
                utilization = entitlement > 0 ? 0 : 0; // Assume fresh month
                windows.push({
                    utilization: 0,
                    label: `monthly${plan ? ` (${planLabel})` : ""}`,
                    resetsAt: parseQuotaResetDate(copilotData.quota_reset_date_utc ||
                        copilotData.quota_reset_date ||
                        copilotData.limited_user_reset_date),
                    remaining,
                    entitlement,
                });
            }
            else if (copilotData?.limited_user_quotas) {
                // Fallback limited_user_quotas format
                const lq = copilotData.limited_user_quotas;
                entitlement = (lq.completions ?? 0) + (lq.chat ?? 0);
                remaining = entitlement;
                utilization = 0;
                windows.push({
                    utilization: 0,
                    label: `limited${plan ? ` (${planLabel})` : ""}`,
                    resetsAt: parseQuotaResetDate(copilotData.quota_reset_date_utc ||
                        copilotData.quota_reset_date ||
                        copilotData.limited_user_reset_date),
                    remaining,
                    entitlement,
                });
            }
            // Add overage info to the first window label if applicable
            if (overagePermitted && windows.length > 0 && !isUnlimited) {
                windows[0].label += " +overage";
            }
            if (isUnlimited && windows.length > 0) {
                windows[0].label = windows[0].label.replace("quota", "unlimited");
            }
            // If no copilot data at all (e.g. no subscription), still show user info
            if (!copilotData && copilotError) {
                const noSub = copilotError === "No Copilot subscription";
                return {
                    providerId: this.id,
                    providerName: this.name,
                    billingType: this.billingType,
                    status: noSub ? "ok" : "error",
                    plan: planLabel,
                    usage: {
                        type: "quotaBased",
                        utilization: 0,
                        windows: [],
                    },
                    accounts: [
                        {
                            label: login,
                            email: login,
                            plan: planLabel,
                            status: noSub ? "ok" : "error",
                            usage: { type: "quotaBased", utilization: 0, windows: [] },
                            error: noSub ? undefined : copilotError,
                        },
                    ],
                    error: noSub ? undefined : copilotError,
                    fetchedAt: Date.now(),
                };
            }
            // Build account result
            const accountResult = {
                label: login,
                email: login,
                plan: planLabel,
                status: "ok",
                usage: {
                    type: "quotaBased",
                    utilization: Math.round(utilization),
                    remaining,
                    entitlement,
                    windows,
                },
            };
            // Add plan info as a label suffix on the main result
            const mainLabel = plan ? `${this.name} (${planLabel})` : this.name;
            return {
                providerId: this.id,
                providerName: mainLabel,
                billingType: this.billingType,
                status: "ok",
                plan: planLabel,
                usage: {
                    type: "quotaBased",
                    utilization: Math.round(utilization),
                    remaining,
                    entitlement,
                    windows,
                },
                accounts: [accountResult],
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
//# sourceMappingURL=copilot.js.map