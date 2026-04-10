// Gemini CLI usage provider
// Endpoint: POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
// Requires OAuth token refresh with client_id, client_secret, refresh_token

import { getGeminiOAuthCreds } from './auth.js'
import { fetchWithTimeout } from './types.js'
import type { ProviderAccountResult, ProviderResult, UsageProvider, UsageWindow } from './types.js'

const QUOTA_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

interface QuotaBucket {
  modelId: string
  remainingFraction: number
  resetTime: string
}

interface QuotaResponse {
  buckets: QuotaBucket[]
}

async function refreshGoogleAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<string | undefined> {
  try {
    const res = await fetchWithTimeout(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    })
    if (!res.ok) return undefined
    const json = (await res.json()) as { access_token: string }
    return json.access_token
  } catch {
    return undefined
  }
}

export const geminiProvider: UsageProvider = {
  id: 'gemini',
  name: 'Gemini CLI',
  billingType: 'quotaBased',

  async isConfigured(): Promise<boolean> {
    return !!getGeminiOAuthCreds()
  },

  async fetchUsage(): Promise<ProviderResult> {
    const creds = getGeminiOAuthCreds()
    if (!creds) {
      return {
        providerId: this.id,
        providerName: this.name,
        billingType: this.billingType,
        status: 'not_configured',
        fetchedAt: Date.now(),
      }
    }

    // Refresh the access token
    const accessToken = await refreshGoogleAccessToken(
      creds.client_id,
      creds.client_secret,
      creds.refresh_token
    )
    if (!accessToken) {
      return {
        providerId: this.id,
        providerName: this.name,
        billingType: this.billingType,
        status: 'auth_expired',
        error: 'Failed to refresh Google OAuth token',
        fetchedAt: Date.now(),
      }
    }

    try {
      const res = await fetchWithTimeout(QUOTA_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ project: '' }),
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

      const json = (await res.json()) as QuotaResponse
      const buckets = json.buckets || []

      if (buckets.length === 0) {
        return {
          providerId: this.id,
          providerName: this.name,
          billingType: this.billingType,
          status: 'ok',
          usage: { type: 'quotaBased', utilization: 0, windows: [] },
          fetchedAt: Date.now(),
        }
      }

      const windows: UsageWindow[] = buckets.map((b) => ({
        utilization: (1 - b.remainingFraction) * 100,
        resetsAt: b.resetTime ? new Date(b.resetTime).getTime() : undefined,
        label: b.modelId || 'unknown',
      }))

      const accounts: ProviderAccountResult[] = windows.map((window) => ({
        label: window.label,
        status: 'ok',
        usage: {
          type: 'quotaBased',
          utilization: window.utilization,
          windows: [window],
        },
      }))

      // Overall utilization: highest used model
      const primaryUtil = Math.max(...windows.map((w) => w.utilization))

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
        accounts,
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
