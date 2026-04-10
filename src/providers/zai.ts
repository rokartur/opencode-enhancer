// Z.AI coding plan usage provider
// Quota: GET https://api.z.ai/api/monitor/usage/quota/limit
// Auth: raw key in Authorization header (no Bearer prefix)

import { getApiKey, hasCredential } from './auth.js'
import { fetchWithTimeout } from './types.js'
import type { ProviderResult, UsageProvider, UsageWindow } from './types.js'

const QUOTA_ENDPOINT = 'https://api.z.ai/api/monitor/usage/quota/limit'
const AUTH_KEY = 'zai-coding-plan'

interface QuotaLimit {
  type: string
  percentage: number
  currentValue: number
  total: number
  nextResetTime: string
}

interface ZaiQuotaResponse {
  data: {
    limits: QuotaLimit[]
  }
}

export const zaiProvider: UsageProvider = {
  id: 'zai',
  name: 'Z.AI',
  billingType: 'quotaBased',

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
      const res = await fetchWithTimeout(QUOTA_ENDPOINT, {
        headers: { Authorization: apiKey }, // No Bearer prefix
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

      const json = (await res.json()) as ZaiQuotaResponse
      const limits = json.data?.limits || []
      const windows: UsageWindow[] = []
      let maxUtilization = 0

      for (const limit of limits) {
        const utilization = limit.percentage
        windows.push({
          utilization,
          resetsAt: limit.nextResetTime ? new Date(limit.nextResetTime).getTime() : undefined,
          label: limit.type || 'quota',
        })
        maxUtilization = Math.max(maxUtilization, utilization)
      }

      return {
        providerId: this.id,
        providerName: this.name,
        billingType: this.billingType,
        status: 'ok',
        usage: {
          type: 'quotaBased',
          utilization: maxUtilization,
          windows,
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
