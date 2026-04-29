// Claude (Anthropic) usage provider
// Endpoint: GET https://api.anthropic.com/api/oauth/usage
// Auth: Authorization: Bearer {accessToken}
// Headers: User-Agent: claude-code/2.1.80, anthropic-beta: oauth-2025-04-20

import { getOAuthToken, hasCredential } from './auth.js'
import { fetchWithTimeout } from './types.js'
import type { ProviderResult, UsageProvider, UsageWindow } from './types.js'

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const PROFILE_ENDPOINT = 'https://api.anthropic.com/api/oauth/profile'
const AUTH_KEY = 'anthropic'

interface UsageWindowResponse {
	utilization: number // 0-100
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

interface ClaudeProfileResponse {
	account?: {
		has_claude_max?: boolean
		has_claude_pro?: boolean
	}
	organization?: {
		organization_type?: string
		seat_tier?: string | null
	}
}

function getHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		'User-Agent': 'claude-code/2.1.80',
		'anthropic-beta': 'oauth-2025-04-20',
		Accept: 'application/json',
	}
}

function formatPlan(value: string): string {
	return value
		.replace(/^claude_/, '')
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map(part => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ')
}

function getPlan(profile: ClaudeProfileResponse): string | undefined {
	if (profile.account?.has_claude_max) return 'Max'
	if (profile.account?.has_claude_pro) return 'Pro'
	if (profile.organization?.seat_tier) return formatPlan(profile.organization.seat_tier)
	if (profile.organization?.organization_type) return formatPlan(profile.organization.organization_type)
	return undefined
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
			const headers = getHeaders(token)
			const res = await fetchWithTimeout(USAGE_ENDPOINT, {
				headers,
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

			const [json, profile] = await Promise.all([
				res.json() as Promise<ClaudeUsageResponse>,
				fetchWithTimeout(PROFILE_ENDPOINT, { headers })
					.then(profileRes =>
						profileRes.ok ? (profileRes.json() as Promise<ClaudeProfileResponse>) : undefined,
					)
					.catch(() => undefined),
			])
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
			const primaryUtil = Math.max(json.five_hour?.utilization ?? 0, json.seven_day?.utilization ?? 0)

			return {
				providerId: this.id,
				providerName: this.name,
				billingType: this.billingType,
				plan: profile ? getPlan(profile) : undefined,
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
