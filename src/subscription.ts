import { getSubscriptionActiveUntilFromClaims } from './codex-auth.js'
import { decodeJwtPayload } from './jwt.js'
import type { AccountCredentials } from './types.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

type SubscriptionAccount = Pick<AccountCredentials, 'accessToken' | 'idToken' | 'subscriptionActiveUntil'>

export function getAccountSubscriptionActiveUntil(account: SubscriptionAccount): number | undefined {
	return (
		account.subscriptionActiveUntil ||
		getSubscriptionActiveUntilFromClaims(decodeJwtPayload(account.accessToken)) ||
		getSubscriptionActiveUntilFromClaims(decodeJwtPayload(account.idToken || ''))
	)
}

export function formatSubscriptionDaysLabel(
	subscriptionActiveUntil: number | undefined,
	now: number = Date.now(),
): string {
	if (!subscriptionActiveUntil) return '-'

	const remainingMs = subscriptionActiveUntil - now
	if (remainingMs <= 0) return 'expired'

	return `${Math.ceil(remainingMs / MS_PER_DAY)}d`
}
