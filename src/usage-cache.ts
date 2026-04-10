import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ProviderResult } from './providers/types.js'

const CACHE_DIR_ENV = 'OPENCODE_ENHANCER_CACHE_DIR'
const LEGACY_CACHE_DIR_ENV = 'OPENCODE_MULTI_AUTH_CACHE_DIR'
const LEGACY_DEFAULT_CACHE_DIR = join(homedir(), '.cache', 'opencode-multi-auth')
const DEFAULT_CACHE_DIR = join(homedir(), '.cache', 'opencode-enhancer')
const CACHE_FILE = 'usage-cache.json'
const CACHE_TTL_MS = 3 * 60 * 1000 // 3 minutes
let cacheLocationChecked = false

function getEnvPath(...keys: string[]): string | null {
  for (const key of keys) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return null
}

function migrateLegacyCacheDir(): void {
  if (cacheLocationChecked) return
  cacheLocationChecked = true

  if (getEnvPath(CACHE_DIR_ENV, LEGACY_CACHE_DIR_ENV)) {
    return
  }

  if (existsSync(LEGACY_DEFAULT_CACHE_DIR) && !existsSync(DEFAULT_CACHE_DIR)) {
    try {
      mkdirSync(join(DEFAULT_CACHE_DIR, '..'), { recursive: true })
      renameSync(LEGACY_DEFAULT_CACHE_DIR, DEFAULT_CACHE_DIR)
      return
    } catch {
      // Fall back to moving the cache file only.
    }
  }

  const legacyFile = join(LEGACY_DEFAULT_CACHE_DIR, CACHE_FILE)
  const nextFile = join(DEFAULT_CACHE_DIR, CACHE_FILE)
  if (!existsSync(legacyFile) || existsSync(nextFile)) return

  mkdirSync(DEFAULT_CACHE_DIR, { recursive: true })
  renameSync(legacyFile, nextFile)
}

function getCacheDir(): string {
  migrateLegacyCacheDir()
  const override = getEnvPath(CACHE_DIR_ENV, LEGACY_CACHE_DIR_ENV)
  return override ? override : DEFAULT_CACHE_DIR
}

export interface UsageCacheEntry {
  results: ProviderResult[]
  fetchedAt: number
}

export function readUsageCache(): UsageCacheEntry | null {
  const filePath = join(getCacheDir(), CACHE_FILE)
  if (!existsSync(filePath)) return null

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as UsageCacheEntry
    if (!parsed.results || !parsed.fetchedAt) return null
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null
    return parsed
  } catch {
    return null
  }
}

export function writeUsageCache(results: ProviderResult[]): void {
  const dir = getCacheDir()
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const entry: UsageCacheEntry = { results, fetchedAt: Date.now() }
    writeFileSync(join(dir, CACHE_FILE), JSON.stringify(entry), { mode: 0o600 })
  } catch {
    // ignore cache write failures
  }
}

export function invalidateUsageCache(): void {
  const filePath = join(getCacheDir(), CACHE_FILE)
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
  } catch {
    // ignore
  }
}
