import test from 'node:test'
import assert from 'node:assert/strict'

import { getSubscriptionActiveUntilFromClaims } from '../codex-auth.js'
import { formatSubscriptionDaysLabel } from '../subscription.js'

const AUTH_NAMESPACE = 'https://api.openai.com/auth'

test('getSubscriptionActiveUntilFromClaims parses ISO subscription expiry', () => {
	const expiresAt = '2026-06-01T00:00:00.000Z'

	assert.equal(
		getSubscriptionActiveUntilFromClaims({
			[AUTH_NAMESPACE]: {
				chatgpt_subscription_active_until: expiresAt,
			},
		}),
		Date.parse(expiresAt),
	)
})

test('getSubscriptionActiveUntilFromClaims parses seconds and milliseconds', () => {
	assert.equal(
		getSubscriptionActiveUntilFromClaims({
			[AUTH_NAMESPACE]: {
				chatgpt_subscription_active_until: 1_800_000_000,
			},
		}),
		1_800_000_000_000,
	)

	assert.equal(
		getSubscriptionActiveUntilFromClaims({
			[AUTH_NAMESPACE]: {
				chatgpt_subscription_active_until: 1_800_000_000_000,
			},
		}),
		1_800_000_000_000,
	)
})

test('formatSubscriptionDaysLabel renders days and fallback labels', () => {
	const now = Date.UTC(2026, 0, 1)

	assert.equal(formatSubscriptionDaysLabel(undefined, now), '-')
	assert.equal(formatSubscriptionDaysLabel(now - 1, now), 'expired')
	assert.equal(formatSubscriptionDaysLabel(now + 1, now), '1d')
	assert.equal(formatSubscriptionDaysLabel(now + 3 * 24 * 60 * 60 * 1000, now), '3d')
})
