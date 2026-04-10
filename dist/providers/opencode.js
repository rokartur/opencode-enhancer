// OpenCode credits provider
// Endpoint: GET https://api.opencode.ai/v1/credits
// Auth: Authorization: Bearer {apiKey}
import { getApiKey, hasCredential } from './auth.js';
import { fetchWithTimeout } from './types.js';
const ENDPOINT = 'https://api.opencode.ai/v1/credits';
const AUTH_KEY = 'opencode';
function buildOpenCodeError(provider, billingType, status, error) {
    return {
        providerId: provider.id,
        providerName: provider.name,
        billingType,
        status,
        error,
        fetchedAt: Date.now(),
    };
}
export const openCodeProvider = {
    id: 'opencode',
    name: 'OpenCode',
    billingType: 'payAsYouGo',
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
            const body = await res.text();
            if (!res.ok) {
                return buildOpenCodeError(this, this.billingType, res.status === 401 || res.status === 403 ? 'auth_expired' : 'error', `HTTP ${res.status}: ${body.slice(0, 200)}`);
            }
            let json;
            try {
                json = JSON.parse(body);
            }
            catch {
                const contentType = res.headers.get('content-type') || 'unknown';
                return buildOpenCodeError(this, this.billingType, 'error', `Unexpected OpenCode response (${res.status}, ${contentType}): ${body.slice(0, 200)}`);
            }
            if (!json?.data) {
                return buildOpenCodeError(this, this.billingType, 'error', `Invalid OpenCode credits payload: ${body.slice(0, 200)}`);
            }
            const { total_credits, used_credits, remaining_credits } = json.data;
            const utilization = total_credits > 0 ? (used_credits / total_credits) * 100 : 0;
            return {
                providerId: this.id,
                providerName: this.name,
                billingType: this.billingType,
                status: 'ok',
                usage: {
                    type: 'payAsYouGo',
                    utilization,
                    used: used_credits,
                    total: total_credits,
                    remaining: remaining_credits,
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
//# sourceMappingURL=opencode.js.map