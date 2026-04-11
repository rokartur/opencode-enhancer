// ChatGPT / Codex usage provider
// Uses the existing multi-account store and wham/usage API
// Endpoint: GET https://chatgpt.com/backend-api/wham/usage
import { loadStore, listAccounts } from "../store.js";
import { fetchUsageRateLimitsForAccount } from "../usage-limits.js";
export const codexProvider = {
    id: "codex",
    name: "Codex",
    billingType: "quotaBased",
    async isConfigured() {
        const accounts = listAccounts();
        return accounts.length > 0;
    },
    async fetchUsage() {
        const store = loadStore();
        const accounts = Object.values(store.accounts);
        if (accounts.length === 0) {
            return {
                providerId: this.id,
                providerName: this.name,
                billingType: this.billingType,
                status: "not_configured",
                fetchedAt: Date.now(),
            };
        }
        // Fetch usage for all accounts in parallel
        const results = await Promise.allSettled(accounts.map(async (acc) => {
            // Skip disabled accounts
            if (acc.enabled === false) {
                return {
                    label: acc.alias,
                    email: acc.email,
                    plan: acc.planType,
                    status: "error",
                    error: "Account disabled",
                    usage: { type: "quotaBased", utilization: 0, windows: [] },
                };
            }
            // Skip auth-invalid accounts
            if (acc.authInvalid) {
                return {
                    label: acc.alias,
                    email: acc.email,
                    plan: acc.planType,
                    status: "auth_expired",
                    error: "Auth invalid",
                    usage: { type: "quotaBased", utilization: 0, windows: [] },
                };
            }
            try {
                const result = await fetchUsageRateLimitsForAccount(acc);
                if (result.authInvalid) {
                    return {
                        label: acc.alias,
                        email: acc.email,
                        plan: acc.planType,
                        status: "auth_expired",
                        error: result.error,
                        usage: { type: "quotaBased", utilization: 0, windows: [] },
                    };
                }
                if (result.error && !result.rateLimits) {
                    return {
                        label: acc.alias,
                        email: acc.email,
                        plan: acc.planType,
                        status: "error",
                        error: result.error,
                        usage: { type: "quotaBased", utilization: 0, windows: [] },
                    };
                }
                const windows = [];
                const fh = result.rateLimits?.fiveHour;
                const wk = result.rateLimits?.weekly;
                if (fh?.remaining !== undefined) {
                    const fhLimit = fh.limit ?? 100;
                    const hasAbsoluteFiveHourLimit = typeof fh.limit === "number" && fh.limit !== 100;
                    windows.push({
                        utilization: fhLimit === 100
                            ? Math.max(0, 100 - fh.remaining)
                            : Math.max(0, Math.round(((fhLimit - fh.remaining) / fhLimit) * 100)),
                        resetsAt: fh.resetAt,
                        label: "5h",
                        remaining: hasAbsoluteFiveHourLimit ? fh.remaining : undefined,
                        entitlement: hasAbsoluteFiveHourLimit ? fh.limit : undefined,
                    });
                }
                if (wk?.remaining !== undefined) {
                    const wkLimit = wk.limit ?? 100;
                    const hasAbsoluteWeeklyLimit = typeof wk.limit === "number" && wk.limit !== 100;
                    windows.push({
                        utilization: wkLimit === 100
                            ? Math.max(0, 100 - wk.remaining)
                            : Math.max(0, Math.round(((wkLimit - wk.remaining) / wkLimit) * 100)),
                        resetsAt: wk.resetAt,
                        label: "weekly",
                        remaining: hasAbsoluteWeeklyLimit ? wk.remaining : undefined,
                        entitlement: hasAbsoluteWeeklyLimit ? wk.limit : undefined,
                    });
                }
                const fhLimit = fh?.limit ?? 100;
                const wkLimit = wk?.limit ?? 100;
                const fhUtil = fh?.remaining !== undefined
                    ? fhLimit === 100
                        ? 100 - fh.remaining
                        : ((fhLimit - fh.remaining) / fhLimit) * 100
                    : 0;
                const wkUtil = wk?.remaining !== undefined
                    ? wkLimit === 100
                        ? 100 - wk.remaining
                        : ((wkLimit - wk.remaining) / wkLimit) * 100
                    : 0;
                const primaryUtil = Math.max(0, fhUtil, wkUtil);
                return {
                    label: acc.alias,
                    email: acc.email,
                    plan: acc.planType,
                    status: "ok",
                    usage: {
                        type: "quotaBased",
                        utilization: primaryUtil,
                        windows,
                    },
                };
            }
            catch (err) {
                return {
                    label: acc.alias,
                    email: acc.email,
                    plan: acc.planType,
                    status: "error",
                    error: `${err}`,
                    usage: { type: "quotaBased", utilization: 0, windows: [] },
                };
            }
        }));
        const accountResults = results.map((r) => r.status === "fulfilled"
            ? r.value
            : {
                label: "?",
                status: "error",
                error: `${r.reason}`,
                usage: { type: "quotaBased", utilization: 0, windows: [] },
            });
        // Overall status: ok if any account succeeded
        const anyOk = accountResults.some((a) => a.status === "ok");
        const okAccounts = accountResults.filter((a) => a.status === "ok");
        // Aggregate usage: take the best (lowest utilization) account
        let aggregateUsage = undefined;
        if (okAccounts.length > 0) {
            const best = okAccounts.reduce((a, b) => (a.usage.utilization < b.usage.utilization ? a : b));
            aggregateUsage = best.usage;
        }
        return {
            providerId: this.id,
            providerName: this.name,
            billingType: this.billingType,
            status: anyOk ? "ok" : "error",
            usage: aggregateUsage,
            accounts: accountResults,
            error: anyOk
                ? undefined
                : accountResults
                    .map((a) => a.error)
                    .filter(Boolean)
                    .join("; "),
            fetchedAt: Date.now(),
        };
    },
};
//# sourceMappingURL=codex.js.map