// OpenCode credits provider
// Endpoint: GET https://api.opencode.ai/v1/credits
// Auth: Authorization: Bearer {apiKey}

import { getApiKey, hasCredential } from './auth.js'
import { fetchWithTimeout } from './types.js'
import type { ProviderResult, UsageProvider } from './types.js'

const ENDPOINT = 'https://api.opencode.ai/v1/credits'
const AUTH_KEY = 'opencode'

interface CreditsResponse {
  data: {
    total_credits: number
    used_credits: number
    remaining_credits: number
  }
}

export const openCodeProvider: UsageProvider = {
  id: 'opencode',
  name: 'OpenCode',
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
      const res = await fetchWithTimeout(ENDPOINT, {
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
      const { total_credits, used_credits, remaining_credits } = json.data
      const utilization = total_credits > 0 ? (used_credits / total_credits) * 100 : 0

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
