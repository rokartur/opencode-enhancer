// OpenRouter credits provider
// Credits: GET https://openrouter.ai/api/v1/credits
// Key info: GET https://openrouter.ai/api/v1/key
// Auth: Authorization: Bearer {apiKey}

import { getApiKey, hasCredential } from './auth.js'
import { fetchWithTimeout } from './types.js'
import type { ProviderResult, UsageProvider } from './types.js'

const CREDITS_ENDPOINT = 'https://openrouter.ai/api/v1/credits'
const AUTH_KEY = 'openrouter'

interface CreditsResponse {
  data: {
    total_credits: number
    total_usage: number
  }
}

export const openRouterProvider: UsageProvider = {
  id: 'openrouter',
  name: 'OpenRouter',
  billingType: 'payAsYouGo',

  async isConfigured(): Promise<boolean> {
    return hasCredential(AUTH_KEY)
  },

  async fetchUsage(): Promise<ProviderResult> {
    const apiKey = getApiKey(AUTH_KEY)
    if (!apiKey) {
      return {
        providerId: this.id,
        providerName: this.name,
        billingType: this.billingType,
        status: 'not_configured',
        fetchedAt: Date.now(),
      }
    }

    try {
      const res = await fetchWithTimeout(CREDITS_ENDPOINT, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return {
          providerId: this.id,
          providerName: this.name,
          billingType: this.billingType,
          status: res.status === 401 || res.status === 403 ? 'auth_expired' : 'error',
          error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
          fetchedAt: Date.now(),
        }
      }

      const json = (await res.json()) as CreditsResponse
      const { total_credits, total_usage } = json.data
      const remaining = total_credits - total_usage
      const utilization = total_credits > 0 ? (total_usage / total_credits) * 100 : 0

      return {
        providerId: this.id,
        providerName: this.name,
        billingType: this.billingType,
        status: 'ok',
        usage: {
          type: 'payAsYouGo',
          utilization,
          used: total_usage,
          total: total_credits,
          remaining,
        },
        fetchedAt: Date.now(),
      }
    } catch (err) {
      return {
        providerId: this.id,
        providerName: this.name,
        billingType: this.billingType,
        status: 'error',
        error: `${err}`,
        fetchedAt: Date.now(),
      }
    }
  },
}
