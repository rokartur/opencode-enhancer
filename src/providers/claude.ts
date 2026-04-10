// Claude (Anthropic) usage provider
// Endpoint: GET https://api.anthropic.com/api/oauth/usage
// Auth: Authorization: Bearer {accessToken}
// Headers: User-Agent: claude-code/2.1.80, anthropic-beta: oauth-2025-04-20

import { getOAuthToken, hasCredential } from './auth.js'
import { fetchWithTimeout } from './types.js'
import type { ProviderResult, UsageProvider, UsageWindow } from './types.js'

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const AUTH_KEY = 'anthropic'

interface UsageWindowResponse {
  utilization: number  // 0-100
  resets_at: string
}

interface ClaudeUsageResponse {
  five_hour?: UsageWindowResponse
  seven_day?: UsageWindowResponse
  seven_day_sonnet?: UsageWindowResponse
  seven_day_opus?: UsageWindowResponse
  extra_usage?: {
    is_enabled: boolean
    monthly_limit: number
    used_credits: number
    utilization: number
  }
}

export const claudeProvider: UsageProvider = {
  id: 'claude',
  name: 'Claude',
  billingType: 'quotaBased',

  async isConfigured(): Promise<boolean> {
    return hasCredential(AUTH_KEY)
  },

  async fetchUsage(): Promise<ProviderResult> {
    const token = getOAuthToken(AUTH_KEY)
    if (!token) {
      return {
        providerId: this.id,
        providerName: this.name,
        billingType: this.billingType,
        status: 'not_configured',
        fetchedAt: Date.now(),
      }
    }

    try {
      const res = await fetchWithTimeout(USAGE_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'claude-code/2.1.80',
          'anthropic-beta': 'oauth-2025-04-20',
          Accept: 'application/json',
        },
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

      const json = (await res.json()) as ClaudeUsageResponse
      const windows: UsageWindow[] = []

      if (json.five_hour) {
        windows.push({
          utilization: json.five_hour.utilization,
          resetsAt: new Date(json.five_hour.resets_at).getTime(),
          label: '5h',
        })
      }
      if (json.seven_day) {
        windows.push({
          utilization: json.seven_day.utilization,
          resetsAt: new Date(json.seven_day.resets_at).getTime(),
          label: '7d',
        })
      }
      if (json.seven_day_sonnet) {
        windows.push({
          utilization: json.seven_day_sonnet.utilization,
          resetsAt: new Date(json.seven_day_sonnet.resets_at).getTime(),
          label: '7d sonnet',
        })
      }
      if (json.seven_day_opus) {
        windows.push({
          utilization: json.seven_day_opus.utilization,
          resetsAt: new Date(json.seven_day_opus.resets_at).getTime(),
          label: '7d opus',
        })
      }

      // Primary utilization: use the highest of 5h or 7d
      const primaryUtil = Math.max(
        json.five_hour?.utilization ?? 0,
        json.seven_day?.utilization ?? 0
      )

      return {
        providerId: this.id,
        providerName: this.name,
        billingType: this.billingType,
        status: 'ok',
        usage: {
          type: 'quotaBased',
          utilization: primaryUtil,
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


