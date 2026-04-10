// Read auth tokens from OpenCode's auth.json file
// Located at ~/.local/share/opencode/auth.json (XDG_DATA_HOME/opencode/auth.json)

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

interface OAuthCredential {
  type: 'oauth'
  access: string
  refresh?: string
  expires?: number
  accountId?: string
}

interface ApiKeyCredential {
  type: 'apikey'
  key: string
}

type AuthCredential = OAuthCredential | ApiKeyCredential

interface OpenCodeAuth {
  [key: string]: AuthCredential | undefined
}

let cachedAuth: OpenCodeAuth | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 10_000 // 10 seconds

function getAuthFilePath(): string {
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(xdgData, 'opencode', 'auth.json')
}

function loadAuthFile(): OpenCodeAuth {
  const now = Date.now()
  if (cachedAuth && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedAuth
  }

  const filePath = getAuthFilePath()
  if (!existsSync(filePath)) {
    cachedAuth = {}
    cacheTimestamp = now
    return cachedAuth
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    cachedAuth = JSON.parse(raw) as OpenCodeAuth
    cacheTimestamp = now
    return cachedAuth
  } catch {
    cachedAuth = {}
    cacheTimestamp = now
    return cachedAuth
  }
}

/** Get an OAuth access token for a provider key (e.g. 'anthropic', 'openai', 'github-copilot') */
export function getOAuthToken(key: string): string | undefined {
  const auth = loadAuthFile()
  const cred = auth[key]
  if (!cred || cred.type !== 'oauth') return undefined
  return cred.access || undefined
}

/** Get an OAuth refresh token for a provider key */
export function getOAuthRefreshToken(key: string): string | undefined {
  const auth = loadAuthFile()
  const cred = auth[key]
  if (!cred || cred.type !== 'oauth') return undefined
  return cred.refresh || undefined
}

/** Get an OAuth credential object for a provider key */
export function getOAuthCredential(key: string): OAuthCredential | undefined {
  const auth = loadAuthFile()
  const cred = auth[key]
  if (!cred || cred.type !== 'oauth') return undefined
  return cred as OAuthCredential
}

/** Get an API key for a provider key (e.g. 'openrouter', 'opencode', 'kimi-for-coding') */
export function getApiKey(key: string): string | undefined {
  const auth = loadAuthFile()
  const cred = auth[key]
  if (!cred) return undefined
  if (cred.type === 'apikey') return cred.key || undefined
  // Some providers may store key in access field with oauth type
  if (cred.type === 'oauth') return cred.access || undefined
  return undefined
}

/** Check if a provider key has any credential configured */
export function hasCredential(key: string): boolean {
  const auth = loadAuthFile()
  const cred = auth[key]
  if (!cred) return false
  if (cred.type === 'apikey') return !!cred.key
  if (cred.type === 'oauth') return !!cred.access
  return false
}

/** Invalidate the auth cache (useful after token refresh) */
export function invalidateAuthCache(): void {
  cachedAuth = null
  cacheTimestamp = 0
}

/** Get the path to the auth file (for display purposes) */
export function getAuthPath(): string {
  return getAuthFilePath()
}

// Also check Gemini CLI oauth creds at ~/.gemini/oauth_creds.json
export interface GeminiOAuthCreds {
  client_id: string
  client_secret: string
  refresh_token: string
}

export function getGeminiOAuthCreds(): GeminiOAuthCreds | undefined {
  // Try multiple locations
  const paths = [
    join(homedir(), '.gemini', 'oauth_creds.json'),
    join(homedir(), '.config', 'opencode', 'antigravity-accounts.json'),
  ]

  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const raw = readFileSync(p, 'utf-8')
      const parsed = JSON.parse(raw)

      // Direct oauth_creds.json format
      if (parsed.client_id && parsed.refresh_token) {
        return parsed as GeminiOAuthCreds
      }

      // Antigravity accounts format — take first account
      if (Array.isArray(parsed)) {
        const first = parsed[0]
        if (first?.client_id && first?.refresh_token) {
          return first as GeminiOAuthCreds
        }
      }
    } catch {
      continue
    }
  }

  // Also check opencode auth.json for google.oauth
  const auth = loadAuthFile()
  const googleOAuth = auth['google.oauth'] || auth['google']
  if (googleOAuth && googleOAuth.type === 'oauth' && googleOAuth.refresh) {
    const clientId = process.env.OPENCODE_ENHANCER_GOOGLE_CLIENT_ID || process.env.OPENCODE_MULTI_AUTH_GOOGLE_CLIENT_ID || ''
    const clientSecret = process.env.OPENCODE_ENHANCER_GOOGLE_CLIENT_SECRET || process.env.OPENCODE_MULTI_AUTH_GOOGLE_CLIENT_SECRET || ''
    if (!clientId || !clientSecret) return undefined
    return {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: googleOAuth.refresh,
    }
  }

  return undefined
}
