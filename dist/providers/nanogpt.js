// Nano-GPT usage provider
// Usage: GET https://nano-gpt.com/api/subscription/v1/usage
// Balance: POST https://nano-gpt.com/api/check-balance
// Auth: Authorization: Bearer {apiKey} + x-api-key: {apiKey}
import { getApiKey, hasCredential } from './auth.js';
import { fetchWithTimeout } from './types.js';
const USAGE_ENDPOINT = 'https://nano-gpt.com/api/subscription/v1/usage';
const BALANCE_ENDPOINT = 'https://nano-gpt.com/api/check-balance';
const AUTH_KEY = 'nano-gpt';
export const nanoGptProvider = {
    id: 'nanogpt',
    name: 'Nano-GPT',
    billingType: 'quotaBased',
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
                status: 'not_configured',
                fetchedAt: Date.now(),
            };
        }
        const headers = {
            Authorization: `Bearer ${apiKey}`,
            'x-api-key': apiKey,
        };
        try {
            // Fetch usage and balance in parallel
            const [usageRes, balanceRes] = await Promise.allSettled([
                fetchWithTimeout(USAGE_ENDPOINT, { headers }),
                fetchWithTimeout(BALANCE_ENDPOINT, { method: 'POST', headers: { 'x-api-key': apiKey } }),
            ]);
            const windows = [];
            let maxUtilization = 0;
            // Parse usage
            if (usageRes.status === 'fulfilled' && usageRes.value.ok) {
                const usage = (await usageRes.value.json());
                if (usage.weeklyInputTokens) {
                    const util = usage.weeklyInputTokens.percentUsed;
                    windows.push({
                        utilization: util,
                        resetsAt: usage.weeklyInputTokens.resetAt
                            ? new Date(usage.weeklyInputTokens.resetAt).getTime()
                            : undefined,
                        label: 'weekly',
                    });
                    maxUtilization = Math.max(maxUtilization, util);
                }
                if (usage.dailyInputTokens) {
                    const util = usage.dailyInputTokens.percentUsed;
                    windows.push({
                        utilization: util,
                        resetsAt: usage.dailyInputTokens.resetAt
                            ? new Date(usage.dailyInputTokens.resetAt).getTime()
                            : undefined,
                        label: 'daily',
                    });
                    maxUtilization = Math.max(maxUtilization, util);
                }
                if (usage.monthlyInputTokens) {
                    const util = usage.monthlyInputTokens.percentUsed;
                    windows.push({
                        utilization: util,
                        resetsAt: usage.monthlyInputTokens.resetAt
                            ? new Date(usage.monthlyInputTokens.resetAt).getTime()
                            : undefined,
                        label: 'monthly',
                    });
                    maxUtilization = Math.max(maxUtilization, util);
                }
            }
            else {
                const errText = usageRes.status === 'fulfilled'
                    ? `HTTP ${usageRes.value.status}`
                    : `${usageRes.reason}`;
                if (usageRes.status === 'fulfilled' &&
                    (usageRes.value.status === 401 || usageRes.value.status === 403)) {
                    return {
                        providerId: this.id,
                        providerName: this.name,
                        billingType: this.billingType,
                        status: 'auth_expired',
                        error: errText,
                        fetchedAt: Date.now(),
                    };
                }
            }
            // Parse balance (informational, append to windows if we got it)
            if (balanceRes.status === 'fulfilled' && balanceRes.value.ok) {
                const balance = (await balanceRes.value.json());
                // We don't have a max for balance, so we can't compute utilization.
                // Just note it in a window with 0% utilization for display.
                if (balance.usd_balance !== undefined) {
                    windows.push({
                        utilization: 0,
                        label: `$${balance.usd_balance.toFixed(2)} balance`,
                    });
                }
            }
            return {
                providerId: this.id,
                providerName: this.name,
                billingType: this.billingType,
                status: windows.length > 0 ? 'ok' : 'error',
                usage: windows.length > 0
                    ? { type: 'quotaBased', utilization: maxUtilization, windows }
                    : undefined,
                error: windows.length === 0 ? 'Failed to fetch usage data' : undefined,
                fetchedAt: Date.now(),
            };
        }
        catch (err) {
            return {
                providerId: this.id,
                providerName: this.name,
                billingType: this.billingType,
                status: 'error',
                error: `${err}`,
                fetchedAt: Date.now(),
            };
        }
    },
};
//# sourceMappingURL=nanogpt.js.map