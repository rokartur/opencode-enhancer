// GitHub Copilot usage provider
// Fetches plan info and quota from /copilot_internal/user API
// which returns premium_interactions entitlement, remaining, and plan type.
// Endpoint 1: GET https://api.github.com/user (user identity)
// Endpoint 2: GET https://api.github.com/copilot_internal/user (quota + plan)

import { getOAuthToken, hasCredential } from './auth.js'
import { fetchWithTimeout } from './types.js'
import type { ProviderResult, ProviderAccountResult, UsageProvider, UsageWindow } from './types.js'

const AUTH_KEY = 'github-copilot'
const USER_ENDPOINT = 'https://api.github.com/user'
const COPILOT_INTERNAL_ENDPOINT = 'https://api.github.com/copilot_internal/user'

interface QuotaSnapshot {
	entitlement?: number | string
	remaining?: number | string
	quota_remaining?: number | string
	percent_remaining?: number | string
	unlimited?: boolean
	overage_permitted?: boolean
	overage_count?: number | string
	quota_id?: string
	has_quota?: boolean
	quota_reset_at?: number | string
	overage_budget?: number | string
	budget?: number | string
	budget_total?: number | string
	spending_limit?: number | string
	extra_budget?: number | string
	additional_budget?: number | string
	spent?: number | string
	amount_spent?: number | string
	budget_spent?: number | string
}

interface CopilotInternalResponse {
	copilot_plan?: string
	plan?: string
	user_id?: number | string
	id?: number | string
	quota_reset_date_utc?: string
	quota_reset_date?: string
	limited_user_reset_date?: string
	quota_snapshots?: Record<string, QuotaSnapshot>
	monthly_quotas?: { completions?: number; chat?: number }
	limited_user_quotas?: { completions?: number; chat?: number }
	premium_budget?: number | string
	premium_budget_total?: number | string
	premium_budget_spent?: number | string
	premium_spending_limit?: number | string
	overage_budget?: number | string
	overage_spent?: number | string
}

interface NormalizedQuotaSnapshot {
	entitlement?: number
	remaining?: number
	utilization: number
	extraBudgetEnabled: boolean
	extraBudgetTotal?: number
	extraBudgetUsed?: number
	resetsAt?: number
}

function parseQuotaResetDate(raw: string | undefined): number | undefined {
	if (!raw) return undefined
	try {
		const d = new Date(raw)
		return isNaN(d.getTime()) ? undefined : d.getTime()
	} catch {
		return undefined
	}
}

function parseNumeric(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value === 'string') {
		const normalized = value.trim().replace(/[$,]/g, '')
		if (!normalized) return undefined
		const parsed = Number(normalized)
		return Number.isFinite(parsed) ? parsed : undefined
	}
	return undefined
}

function pickNumeric(...values: unknown[]): number | undefined {
	for (const value of values) {
		const parsed = parseNumeric(value)
		if (parsed !== undefined) return parsed
	}
	return undefined
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value))
}

function parseQuotaResetAt(raw: unknown): number | undefined {
	const value = parseNumeric(raw)
	if (value === undefined || value <= 0) return undefined
	return value > 1_000_000_000_000 ? value : value * 1000
}

function normalizeQuotaSnapshot(
	snapshot: QuotaSnapshot | undefined,
	fallbackResetsAt: number | undefined,
	response: CopilotInternalResponse | undefined,
): NormalizedQuotaSnapshot | undefined {
	if (!snapshot) return undefined

	const entitlement = pickNumeric(snapshot.entitlement)
	const rawRemaining = pickNumeric(snapshot.quota_remaining, snapshot.remaining)
	const percentRemaining = pickNumeric(snapshot.percent_remaining)
	const extraBudgetTotal = pickNumeric(
		snapshot.overage_budget,
		snapshot.budget_total,
		snapshot.spending_limit,
		snapshot.extra_budget,
		snapshot.additional_budget,
		snapshot.budget,
		response?.premium_budget_total,
		response?.premium_spending_limit,
		response?.premium_budget,
		response?.overage_budget,
	)

	let extraBudgetUsed = pickNumeric(
		snapshot.overage_count,
		snapshot.budget_spent,
		snapshot.amount_spent,
		snapshot.spent,
		response?.premium_budget_spent,
		response?.overage_spent,
	)

	if (typeof rawRemaining === 'number' && rawRemaining < 0) {
		extraBudgetUsed = Math.max(extraBudgetUsed || 0, Math.abs(rawRemaining))
	}

	const remaining =
		rawRemaining !== undefined
			? Math.max(0, rawRemaining)
			: entitlement !== undefined && percentRemaining !== undefined
				? (entitlement * clampPercent(percentRemaining)) / 100
				: undefined

	let utilization = 0
	if (snapshot.unlimited) {
		utilization = 0
	} else if (percentRemaining !== undefined) {
		utilization = clampPercent(100 - percentRemaining)
	} else if (entitlement !== undefined && entitlement > 0 && rawRemaining !== undefined) {
		utilization = clampPercent(((entitlement - Math.max(0, rawRemaining)) / entitlement) * 100)
	} else if (rawRemaining !== undefined && rawRemaining < 0) {
		utilization = 100
	}

	return {
		entitlement,
		remaining,
		utilization,
		extraBudgetEnabled: !!snapshot.overage_permitted,
		extraBudgetTotal,
		extraBudgetUsed,
		resetsAt: parseQuotaResetAt(snapshot.quota_reset_at) || fallbackResetsAt,
	}
}

function formatPlanName(plan: string | undefined): string {
	if (!plan) return 'Unknown'
	const map: Record<string, string> = {
		individual_pro: 'Individual Pro',
		individual_free: 'Individual Free',
		business: 'Business',
		enterprise: 'Enterprise',
	}
	return map[plan] || plan.charAt(0).toUpperCase() + plan.slice(1).replace(/_/g, ' ')
}

export const copilotProvider: UsageProvider = {
	id: 'copilot',
	name: 'GitHub Copilot',
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

		const ghHeaders: Record<string, string> = {
			Authorization: `token ${token}`,
			Accept: 'application/json',
			'User-Agent': 'opencode-enhancer',
			'X-GitHub-Api-Version': '2022-11-28',
		}

		try {
			// Fetch user identity and copilot plan/quota in parallel
			const [userRes, copilotRes] = await Promise.allSettled([
				fetchWithTimeout(USER_ENDPOINT, { headers: ghHeaders }),
				fetchWithTimeout(COPILOT_INTERNAL_ENDPOINT, {
					headers: {
						...ghHeaders,
						'Editor-Version': 'vscode/1.96.2',
						'X-GitHub-Api-Version': '2025-04-01',
					},
				}),
			])

			// Parse user identity
			let login = 'unknown'
			if (userRes.status === 'fulfilled' && userRes.value.ok) {
				try {
					const user = (await userRes.value.json()) as { login?: string; name?: string }
					login = user.login || 'unknown'
				} catch {
					/* ignore */
				}
			}
			const userAuthFailed =
				userRes.status === 'fulfilled' && (userRes.value.status === 401 || userRes.value.status === 403)

			if (userAuthFailed) {
				return {
					providerId: this.id,
					providerName: this.name,
					billingType: this.billingType,
					status: 'auth_expired',
					error: `HTTP ${userRes.value.status}`,
					fetchedAt: Date.now(),
				}
			}

			// Parse copilot internal response
			let copilotData: CopilotInternalResponse | undefined
			let copilotError: string | undefined

			if (copilotRes.status === 'fulfilled') {
				if (copilotRes.value.ok) {
					try {
						copilotData = (await copilotRes.value.json()) as CopilotInternalResponse
					} catch {
						copilotError = 'Invalid JSON from copilot_internal/user'
					}
				} else {
					const status = copilotRes.value.status
					if (status === 404) {
						// Plan doesn't have Copilot at all — this is not an error, just no Copilot
						copilotError = 'No Copilot subscription'
					} else if (status === 401 || status === 403) {
						copilotError = 'Auth failed for copilot_internal/user'
					} else {
						const text = await copilotRes.value.text().catch(() => '')
						copilotError = `HTTP ${status}: ${text.slice(0, 100)}`
					}
				}
			} else {
				copilotError = `${copilotRes.reason}`
			}

			// Build result
			const plan = copilotData?.copilot_plan || copilotData?.plan
			const planLabel = formatPlanName(plan)
			const windows: UsageWindow[] = []
			let utilization = 0
			let remaining: number | undefined
			let entitlement: number | undefined
			let overagePermitted = false
			let isUnlimited = false
			let extraBudgetTotal: number | undefined
			let extraBudgetUsed: number | undefined

			const quotaResetsAt = parseQuotaResetDate(
				copilotData?.quota_reset_date_utc ||
					copilotData?.quota_reset_date ||
					copilotData?.limited_user_reset_date,
			)

			if (copilotData?.quota_snapshots) {
				// Prefer premium_interactions, then sum all snapshots
				const snapshots = copilotData.quota_snapshots
				const premium =
					snapshots.premium_interactions ??
					snapshots.premium_models ??
					snapshots.premium_requests ??
					snapshots.premium ??
					Object.values(
						Object.fromEntries(Object.entries(snapshots).filter(([k]) => k.includes('premium'))),
					)[0]
				const chat = snapshots.chat
				const completions = snapshots.completions

				if (premium) {
					// Premium interactions is the authoritative quota for individual pro plans
					const normalizedPremium = normalizeQuotaSnapshot(premium, quotaResetsAt, copilotData)

					if (premium.unlimited) {
						isUnlimited = true
					}

					entitlement = normalizedPremium?.entitlement
					remaining = normalizedPremium?.remaining
					utilization = normalizedPremium?.utilization ?? 0
					overagePermitted = normalizedPremium?.extraBudgetEnabled ?? false
					extraBudgetTotal = normalizedPremium?.extraBudgetTotal
					extraBudgetUsed = normalizedPremium?.extraBudgetUsed

					windows.push({
						utilization: Math.round(isUnlimited ? 0 : (normalizedPremium?.utilization ?? utilization)),
						label: `premium${plan ? ` (${planLabel})` : ''}`,
						resetsAt: normalizedPremium?.resetsAt || quotaResetsAt,
						remaining,
						entitlement,
						extraBudgetEnabled: overagePermitted,
						extraBudgetTotal,
						extraBudgetUsed,
					})
				} else {
					// Sum all snapshot categories
					let totalEntitlement = 0
					let totalRemaining = 0
					let anyUnlimited = false

					for (const [, snap] of Object.entries(snapshots)) {
						const normalized = normalizeQuotaSnapshot(snap, quotaResetsAt, copilotData)
						if (snap.unlimited) {
							anyUnlimited = true
						}
						if (normalized?.extraBudgetEnabled) {
							overagePermitted = true
						}
						if (normalized?.extraBudgetTotal !== undefined) {
							extraBudgetTotal = (extraBudgetTotal || 0) + normalized.extraBudgetTotal
						}
						if (normalized?.extraBudgetUsed !== undefined) {
							extraBudgetUsed = (extraBudgetUsed || 0) + normalized.extraBudgetUsed
						}
						if (normalized?.entitlement !== undefined && normalized.entitlement > 0) {
							totalEntitlement += normalized.entitlement
							if (normalized.remaining !== undefined) {
								totalRemaining += normalized.remaining
							}
						}
					}

					if (anyUnlimited && totalEntitlement === 0) {
						isUnlimited = true
						utilization = 0
					} else if (totalEntitlement > 0) {
						const used = totalEntitlement - Math.max(0, totalRemaining)
						utilization = totalEntitlement > 0 ? (used / totalEntitlement) * 100 : 0
						entitlement = totalEntitlement
						remaining = Math.max(0, totalRemaining)
					}

					windows.push({
						utilization: Math.round(clampPercent(utilization)),
						label: plan ? `(${planLabel})` : 'quota',
						resetsAt: quotaResetsAt,
						remaining,
						entitlement,
						extraBudgetEnabled: overagePermitted,
						extraBudgetTotal,
						extraBudgetUsed,
					})
				}
			} else if (copilotData?.monthly_quotas) {
				// Legacy monthly_quotas format
				const mq = copilotData.monthly_quotas
				entitlement = (mq.completions ?? 0) + (mq.chat ?? 0)
				remaining = entitlement // No remaining info in legacy format
				utilization = entitlement > 0 ? 0 : 0 // Assume fresh month
				windows.push({
					utilization: 0,
					label: `monthly${plan ? ` (${planLabel})` : ''}`,
					resetsAt: quotaResetsAt,
					remaining,
					entitlement,
				})
			} else if (copilotData?.limited_user_quotas) {
				// Fallback limited_user_quotas format
				const lq = copilotData.limited_user_quotas
				entitlement = (lq.completions ?? 0) + (lq.chat ?? 0)
				remaining = entitlement
				utilization = 0
				windows.push({
					utilization: 0,
					label: `limited${plan ? ` (${planLabel})` : ''}`,
					resetsAt: quotaResetsAt,
					remaining,
					entitlement,
				})
			}

			// Add overage info to the first window label if applicable
			if (overagePermitted && windows.length > 0 && !isUnlimited) {
				windows[0].label += ' +overage'
			}
			if (isUnlimited && windows.length > 0) {
				windows[0].label = windows[0].label.replace('quota', 'unlimited')
			}

			// If no copilot data at all (e.g. no subscription), still show user info
			if (!copilotData && copilotError) {
				const noSub = copilotError === 'No Copilot subscription'
				return {
					providerId: this.id,
					providerName: this.name,
					billingType: this.billingType,
					status: noSub ? 'ok' : 'error',
					plan: planLabel,
					usage: {
						type: 'quotaBased',
						utilization: 0,
						windows: [],
					},
					accounts: [
						{
							label: login,
							email: login,
							plan: planLabel,
							status: noSub ? 'ok' : 'error',
							usage: { type: 'quotaBased', utilization: 0, windows: [] },
							error: noSub ? undefined : copilotError,
						},
					],
					error: noSub ? undefined : copilotError,
					fetchedAt: Date.now(),
				}
			}

			// Build account result
			const accountResult: ProviderAccountResult = {
				label: login,
				email: login,
				plan: planLabel,
				status: 'ok',
				usage: {
					type: 'quotaBased',
					utilization: Math.round(clampPercent(utilization)),
					remaining,
					entitlement,
					windows,
				},
			}

			// Add plan info as a label suffix on the main result
			const mainLabel = plan ? `${this.name} (${planLabel})` : this.name

			return {
				providerId: this.id,
				providerName: mainLabel,
				billingType: this.billingType,
				status: 'ok',
				plan: planLabel,
				usage: {
					type: 'quotaBased',
					utilization: Math.round(clampPercent(utilization)),
					remaining,
					entitlement,
					windows,
				},
				accounts: [accountResult],
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
