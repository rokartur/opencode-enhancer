// Synthetic quotas provider
// Endpoint: GET https://api.synthetic.new/v2/quotas
// Auth: Authorization: Bearer {apiKey}
import { getApiKey, hasCredential } from './auth.js';
import { fetchWithTimeout } from './types.js';
const ENDPOINT = 'https://api.synthetic.new/v2/quotas';
const AUTH_KEY = 'synthetic';
export const syntheticProvider = {
    id: 'synthetic',
    name: 'Synthetic',
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
            const { limit, requests, renewsAt } = json.subscription;
            const remaining = limit - requests;
            const utilization = limit > 0 ? (requests / limit) * 100 : 0;
            const resetsAt = renewsAt ? new Date(renewsAt).getTime() : undefined;
            return {
                providerId: this.id,
                providerName: this.name,
                billingType: this.billingType,
                status: 'ok',
                usage: {
                    type: 'quotaBased',
                    utilization,
                    remaining,
                    entitlement: limit,
                    windows: [
                        {
                            utilization,
                            resetsAt,
                            label: 'period',
                        },
                    ],
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
//# sourceMappingURL=synthetic.js.map