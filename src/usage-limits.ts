import { ensureValidToken } from './auth.js'
import { getBlockingRateLimitResetAt, hasMeaningfulRateLimits } from './rate-limits.js'
import { fetchWithTimeout } from './providers/types.js'
import { loadStore } from './store.js'
import type { AccountCredentials, AccountRateLimits, RateLimitWindow } from './types.js'

const DEFAULT_USAGE_BASE_URL = 'https://chatgpt.com/backend-api'
const USAGE_BASE_URL_ENV = 'OPENCODE_ENHANCER_USAGE_BASE_URL'
const LEGACY_USAGE_BASE_URL_ENV = 'OPENCODE_MULTI_AUTH_USAGE_BASE_URL'

interface UsageWindowSnapshot {
	used_percent?: number
	limit_window_seconds?: number
	reset_after_seconds?: number
	reset_at?: number
}

interface UsageRateLimitDetails {
	allowed?: boolean
	limit_reached?: boolean
	primary_window?: UsageWindowSnapshot | null
	secondary_window?: UsageWindowSnapshot | null
}

interface AdditionalRateLimitDetails {
	limit_name?: string
	metered_feature?: string
	rate_limit?: UsageRateLimitDetails | null
}

interface UsagePayload {
	plan_type?: string
	rate_limit?: UsageRateLimitDetails | null
	credits?: {
		has_credits?: boolean
		unlimited?: boolean
		balance?: string | null
	} | null
	additional_rate_limits?: AdditionalRateLimitDetails[] | null
}

export interface UsageRateLimitFetchResult {
	rateLimits?: AccountRateLimits
	planType?: string
	rateLimitedUntil?: number
	error?: string
	shouldProbeFallback?: boolean
	authInvalid?: boolean
	workspaceDeactivated?: boolean
	workspaceDeactivatedReason?: string
	source: 'usage-api'
}

interface UsageApiFailureClassification {
	shouldProbeFallback: boolean
	authInvalid?: boolean
	workspaceDeactivated?: boolean
	workspaceDeactivatedReason?: string
}

function getUsageBaseUrl(): string {
	const override = (process.env[USAGE_BASE_URL_ENV] || process.env[LEGACY_USAGE_BASE_URL_ENV])?.trim()
	const baseUrl = override || DEFAULT_USAGE_BASE_URL
	return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

function mapWindow(window: UsageWindowSnapshot | null | undefined, now: number): RateLimitWindow | undefined {
	if (!window) return undefined
	const usedPercent = typeof window.used_percent === 'number' ? window.used_percent : undefined
	const resetAt =
		typeof window.reset_at === 'number'
			? window.reset_at * 1000
			: typeof window.reset_after_seconds === 'number'
				? now + window.reset_after_seconds * 1000
				: undefined

	if (usedPercent === undefined && resetAt === undefined) {
		return undefined
	}

	return {
		limit: 100,
		remaining: typeof usedPercent === 'number' ? Math.max(0, 100 - usedPercent) : undefined,
		resetAt,
		updatedAt: now,
	}
}

function pickRateLimitDetails(payload: UsagePayload): UsageRateLimitDetails | null {
	if (payload.rate_limit) return payload.rate_limit

	const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : []
	const preferred = additional.find(entry => {
		const feature = entry.metered_feature?.trim().toLowerCase()
		const limitName = entry.limit_name?.trim().toLowerCase()
		return feature === 'codex' || limitName === 'codex'
	})
	if (preferred?.rate_limit) return preferred.rate_limit

	return additional.find(entry => entry.rate_limit)?.rate_limit || null
}

function parseUsageFailure(rawText: string): { code?: string; message?: string } {
	const trimmed = rawText.trim()
	if (!trimmed) {
		return {}
	}

	try {
		const payload = JSON.parse(trimmed) as any
		const code =
			(typeof payload?.detail?.code === 'string' && payload.detail.code) ||
			(typeof payload?.error?.code === 'string' && payload.error.code) ||
			undefined
		const message =
			(typeof payload?.detail?.message === 'string' && payload.detail.message) ||
			(typeof payload?.detail === 'string' && payload.detail) ||
			(typeof payload?.error?.message === 'string' && payload.error.message) ||
			(typeof payload?.message === 'string' && payload.message) ||
			undefined
		return { code, message }
	} catch {
		return { message: trimmed }
	}
}

function formatUsageApiError(status: number, rawText: string): string {
	const trimmed = rawText.trim()
	const { message, code } = parseUsageFailure(rawText)
	const detail = message || code || (trimmed ? trimmed.slice(0, 280) : '')
	return `Usage API returned ${status}${detail ? `: ${detail}` : ''}`
}

export function classifyUsageApiFailure(status: number, rawText: string): UsageApiFailureClassification {
	const { code, message } = parseUsageFailure(rawText)
	const normalized = [code, message, rawText.trim()].filter(Boolean).join(' ').toLowerCase()

	if (status === 401 || status === 403) {
		return {
			shouldProbeFallback: false,
			authInvalid: true,
		}
	}

	if (
		status === 402 &&
		(normalized.includes('deactivated_workspace') || normalized.includes('deactivated workspace'))
	) {
		return {
			shouldProbeFallback: false,
			workspaceDeactivated: true,
			workspaceDeactivatedReason: message || code || rawText.trim() || undefined,
		}
	}

	return { shouldProbeFallback: true }
}

export async function fetchUsageRateLimitsForAccount(account: AccountCredentials): Promise<UsageRateLimitFetchResult> {
	const refreshedToken = await ensureValidToken(account.alias)
	const latestAccount = loadStore().accounts[account.alias] || account

	if (latestAccount.authInvalid) {
		return {
			source: 'usage-api',
			error: 'Authentication expired; token refresh failed',
			shouldProbeFallback: false,
			authInvalid: true,
		}
	}

	const token = (refreshedToken || latestAccount.accessToken)?.trim()
	if (!token) {
		return {
			source: 'usage-api',
			error: 'Missing access token',
		}
	}

	const url = `${getUsageBaseUrl()}/wham/usage`
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		'User-Agent': 'codex-cli',
	}
	if (latestAccount.accountId) {
		headers['ChatGPT-Account-Id'] = latestAccount.accountId
	}

	let res: Response
	try {
		res = await fetchWithTimeout(url, { method: 'GET', headers })
	} catch (err) {
		return {
			source: 'usage-api',
			error: `Usage API request failed: ${err}`,
		}
	}

	let rawText = ''
	try {
		rawText = await res.text()
	} catch {
		rawText = ''
	}

	if (!res.ok) {
		const classification = classifyUsageApiFailure(res.status, rawText)
		return {
			source: 'usage-api',
			error: formatUsageApiError(res.status, rawText),
			...classification,
		}
	}

	let payload: UsagePayload
	try {
		payload = JSON.parse(rawText) as UsagePayload
	} catch (err) {
		return {
			source: 'usage-api',
			error: `Usage API returned invalid JSON: ${err}`,
		}
	}

	const now = Date.now()
	const details = pickRateLimitDetails(payload)
	const rateLimits: AccountRateLimits = {
		fiveHour: mapWindow(details?.primary_window, now),
		weekly: mapWindow(details?.secondary_window, now),
	}

	if (!hasMeaningfulRateLimits(rateLimits)) {
		return {
			source: 'usage-api',
			planType: payload.plan_type,
			error: 'Usage API response contained no usable rate limit windows',
		}
	}

	const rateLimitedUntil =
		details?.limit_reached || details?.allowed === false ? getBlockingRateLimitResetAt(rateLimits, now) : undefined

	return {
		source: 'usage-api',
		planType: payload.plan_type,
		rateLimits,
		rateLimitedUntil,
	}
}
