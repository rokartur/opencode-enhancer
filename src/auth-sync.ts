import type { Auth } from '@opencode-ai/sdk'
import { addAccount, loadStore, setActiveAlias, updateAccount } from './store.js'
import { decodeJwtPayload } from './jwt.js'
import { getAccountIdFromClaims, getEmailFromClaims, getNameFromClaims } from './codex-auth.js'

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
  const base = email ? email.split('@')[0] : 'account'
  let candidate = base || 'account'
  let suffix = 1
  while (existingAliases.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
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
  if (existingAlias) {
    updateAccount(existingAlias, {
      accessToken: auth.access,
      refreshToken: auth.refresh,
      expiresAt: auth.expires,
      email: derivedEmail,
      name: derivedName,
      accountId: derivedAccountId
    })
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
      updateAccount(existingByEmail, {
        accessToken: auth.access,
        refreshToken: auth.refresh,
        expiresAt: auth.expires,
        email,
        name
      })
      setActiveAlias(existingByEmail)
      return
    }
  }
  const alias = buildAlias(email, new Set(Object.keys(store.accounts)))

  addAccount(alias, {
    accessToken: auth.access,
    refreshToken: auth.refresh,
    expiresAt: auth.expires,
    email,
    name,
    accountId: derivedAccountId,
    source: 'opencode'
  })
  setActiveAlias(alias)
}
