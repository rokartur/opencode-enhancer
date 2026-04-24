import type { AccountCredentials, AccountRateLimits, RateLimitWindow } from './types.js'

function getWindowRemaining(window?: RateLimitWindow, now: number = Date.now()): number | null {
	if (typeof window?.remaining !== 'number') return null
	if (typeof window.resetAt === 'number' && window.resetAt < now) {
		// Window has reset — remaining capacity is back to the full limit.
		return window.limit ?? 100
	}
	return window.remaining
}

export function getUsagePrioritySnapshot(
	rateLimits?: AccountRateLimits,
	now: number = Date.now(),
): { fiveHourRemaining: number | null; weeklyRemaining: number | null } {
	return {
		fiveHourRemaining: getWindowRemaining(rateLimits?.fiveHour, now),
		weeklyRemaining: getWindowRemaining(rateLimits?.weekly, now),
	}
}

function compareRemainingDescending(a: number | null, b: number | null): number {
	const aKnown = typeof a === 'number'
	const bKnown = typeof b === 'number'

	if (aKnown && bKnown) {
		if (b !== a) return b - a
		return 0
	}

	// Unknown remaining is treated as most favorable: the account is
	// either unused or its rate-limit window has already reset, so
	// prefer it over any known (partially consumed) value.
	if (aKnown) return 1
	if (bKnown) return -1
	return 0
}

export function getMinRemaining(rateLimits?: AccountRateLimits, now: number = Date.now()): number {
	const windows = [rateLimits?.fiveHour, rateLimits?.weekly]
	const values: number[] = []
	for (const w of windows) {
		if (typeof w?.remaining !== 'number') continue
		if (typeof w.resetAt === 'number' && w.resetAt < now) continue
		values.push(w.remaining)
	}
	if (values.length === 0) return Infinity
	return Math.min(...values)
}

function compareMinRemainingValues(a: number, b: number): number {
	const aKnown = Number.isFinite(a)
	const bKnown = Number.isFinite(b)
	if (aKnown && bKnown) return b - a
	if (aKnown) return 1
	if (bKnown) return -1
	return 0
}

export function compareAccountsByUsagePriority(
	accountA: AccountCredentials,
	accountB: AccountCredentials,
	options?: {
		healthPriorityA?: number
		healthPriorityB?: number
		now?: number
	},
): number {
	const now = options?.now ?? Date.now()

	const minRemainingDiff = compareMinRemainingValues(
		getMinRemaining(accountA.rateLimits, now),
		getMinRemaining(accountB.rateLimits, now),
	)
	if (minRemainingDiff !== 0) return minRemainingDiff

	const usageA = getUsagePrioritySnapshot(accountA.rateLimits, now)
	const usageB = getUsagePrioritySnapshot(accountB.rateLimits, now)

	const weeklyDiff = compareRemainingDescending(usageA.weeklyRemaining, usageB.weeklyRemaining)
	if (weeklyDiff !== 0) return weeklyDiff

	const fiveHourDiff = compareRemainingDescending(usageA.fiveHourRemaining, usageB.fiveHourRemaining)
	if (fiveHourDiff !== 0) return fiveHourDiff

	const priorityDiff = (options?.healthPriorityB || 0) - (options?.healthPriorityA || 0)
	if (priorityDiff !== 0) return priorityDiff

	const usageCountDiff = (accountA.usageCount || 0) - (accountB.usageCount || 0)
	if (usageCountDiff !== 0) return usageCountDiff

	return accountA.alias.localeCompare(accountB.alias)
}
