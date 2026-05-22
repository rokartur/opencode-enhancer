import type { Auth } from '@opencode-ai/sdk'
import { buildRandomizedAlias } from './alias.js'
import { addAccount, isRemovedAccount, loadStore, setActiveAlias, updateAccount } from './store.js'
import { decodeJwtPayload } from './jwt.js'
import {
	getAccountIdFromClaims,
	getAccountUserIdFromClaims,
	getEmailFromClaims,
	getNameFromClaims,
	getSubscriptionActiveUntilFromClaims,
	getUserIdFromClaims,
} from './codex-auth.js'
import type { AccountCredentials } from './types.js'

const OPENAI_ISSUER = 'https://auth.openai.com'
const AUTH_SYNC_COOLDOWN_MS = 10_000

let lastSyncedAccess: string | null = null
let lastSyncAt = 0

async function fetchUserInfo(accessToken: string): Promise<{ email?: string; name?: string }> {
	try {
		const res = await fetch(`${OPENAI_ISSUER}/userinfo`, {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(5_000),
		})
		if (!res.ok) return {}
		const user = (await res.json()) as { email?: string; name?: string }
		return { email: user.email, name: user.name }
	} catch {
		return {}
	}
}

function findAccountAliasByToken(access: string, refresh?: string): string | null {
	const store = loadStore()
	for (const account of Object.values(store.accounts)) {
		if (account.accessToken === access) return account.alias
		if (refresh && account.refreshToken === refresh) return account.alias
	}
	return null
}

function findAccountAliasByEmail(email: string, store: ReturnType<typeof loadStore>): string | null {
	for (const account of Object.values(store.accounts)) {
		if (account.email && account.email === email) return account.alias
	}
	return null
}

function buildAlias(email: string | undefined, existingAliases: Set<string>): string {
	return buildRandomizedAlias({
		email,
		existingAliases,
	})
}

export async function syncAuthFromOpenCode(getAuth: () => Promise<Auth>): Promise<void> {
	const now = Date.now()
	if (now - lastSyncAt < AUTH_SYNC_COOLDOWN_MS) return
	lastSyncAt = now

	let auth: Auth | null = null
	try {
		auth = await getAuth()
	} catch {
		return
	}

	if (!auth || auth.type !== 'oauth') return
	if (!auth.access) return
	if (auth.access === lastSyncedAccess) return

	lastSyncedAccess = auth.access

	const existingAlias = findAccountAliasByToken(auth.access, auth.refresh)
	const accessClaims = decodeJwtPayload(auth.access)
	const derivedEmail = getEmailFromClaims(accessClaims)
	const derivedName = getNameFromClaims(accessClaims)
	const derivedAccountId = getAccountIdFromClaims(accessClaims)
	const derivedAccountUserId = getAccountUserIdFromClaims(accessClaims)
	const derivedUserId = getUserIdFromClaims(accessClaims)
	const derivedSubscriptionActiveUntil = getSubscriptionActiveUntilFromClaims(accessClaims)
	if (existingAlias) {
		const updates: Partial<AccountCredentials> = {
			accessToken: auth.access,
			refreshToken: auth.refresh,
			expiresAt: auth.expires,
			email: derivedEmail,
			name: derivedName,
			accountId: derivedAccountId,
		}
		if (derivedSubscriptionActiveUntil) {
			updates.subscriptionActiveUntil = derivedSubscriptionActiveUntil
		}
		updateAccount(existingAlias, updates)
		setActiveAlias(existingAlias)
		return
	}

	const store = loadStore()
	const userInfo = await fetchUserInfo(auth.access)
	const email = userInfo.email || derivedEmail
	const name = userInfo.name || derivedName
	if (email) {
		const existingByEmail = findAccountAliasByEmail(email, store)
		if (existingByEmail) {
			const updates: Partial<AccountCredentials> = {
				accessToken: auth.access,
				refreshToken: auth.refresh,
				expiresAt: auth.expires,
				email,
				name,
			}
			if (derivedSubscriptionActiveUntil) {
				updates.subscriptionActiveUntil = derivedSubscriptionActiveUntil
			}
			updateAccount(existingByEmail, updates)
			setActiveAlias(existingByEmail)
			return
		}
	}

	if (
		isRemovedAccount({
			accountId: derivedAccountId,
			accountUserId: derivedAccountUserId,
			userId: derivedUserId,
			email,
		})
	) {
		return
	}

	const alias = buildAlias(email, new Set(Object.keys(store.accounts)))

	addAccount(alias, {
		accessToken: auth.access,
		refreshToken: auth.refresh,
		expiresAt: auth.expires,
		email,
		name,
		accountId: derivedAccountId,
		accountUserId: derivedAccountUserId,
		userId: derivedUserId,
		subscriptionActiveUntil: derivedSubscriptionActiveUntil,
		source: 'opencode',
	})
	setActiveAlias(alias)
}
