// Kimi usage provider
// Endpoint: GET https://api.kimi.com/coding/v1/usages
// Auth: Authorization: Bearer {apiKey}
import { getApiKey, hasCredential } from './auth.js';
import { fetchWithTimeout } from './types.js';
const ENDPOINT = 'https://api.kimi.com/coding/v1/usages';
const AUTH_KEY = 'kimi-for-coding';
export const kimiProvider = {
    id: 'kimi',
    name: 'Kimi',
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
        try {
            const res = await fetchWithTimeout(ENDPOINT, {
                headers: { Authorization: `Bearer ${apiKey}` },
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    providerId: this.id,
                    providerName: this.name,
                    billingType: this.billingType,
                    status: res.status === 401 || res.status === 403 ? 'auth_expired' : 'error',
                    error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
                    fetchedAt: Date.now(),
                };
            }
            const json = (await res.json());
            const windows = [];
            // Primary usage window
            if (json.usage) {
                const { limit, used, remaining, resetTime } = json.usage;
                const utilization = limit > 0 ? (used / limit) * 100 : 0;
                windows.push({
                    utilization,
                    resetsAt: resetTime ? new Date(resetTime).getTime() : undefined,
                    label: 'weekly',
                });
            }
            // Additional limit windows
            if (json.limits) {
                for (const entry of json.limits) {
                    if (entry.detail) {
                        const { limit, used, resetTime } = entry.detail;
                        const utilization = limit > 0 ? (used / limit) * 100 : 0;
                        const unit = entry.window?.timeUnit?.toLowerCase() || '';
                        const duration = entry.window?.duration || 0;
                        const label = unit ? `${duration}${unit.charAt(0)}` : 'window';
                        windows.push({ utilization, resetsAt: resetTime ? new Date(resetTime).getTime() : undefined, label });
                    }
                }
            }
            const primaryUtil = windows.length > 0 ? Math.max(...windows.map((w) => w.utilization)) : 0;
            return {
                providerId: this.id,
                providerName: this.name,
                billingType: this.billingType,
                status: 'ok',
                usage: {
                    type: 'quotaBased',
                    utilization: primaryUtil,
                    remaining: json.usage?.remaining,
                    entitlement: json.usage?.limit,
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
                status: 'error',
                error: `${err}`,
                fetchedAt: Date.now(),
            };
        }
    },
};
//# sourceMappingURL=kimi.js.map