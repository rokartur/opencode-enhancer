import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'node:crypto'
import { hasMeaningfulRateLimits } from './rate-limits.js'
import type {
	AccountStore,
	AccountCredentials,
	RemovedAccountIdentity,
	RateLimitHistoryEntry,
	RateLimitSnapshot,
	RotationSettings,
} from './types.js'
import { sanitizeRotationSettings } from './types.js'

const STORE_DIR_ENV = 'OPENCODE_ENHANCER_STORE_DIR'
const STORE_FILE_ENV = 'OPENCODE_ENHANCER_STORE_FILE'
const LEGACY_STORE_DIR_ENV = 'OPENCODE_MULTI_AUTH_STORE_DIR'
const LEGACY_STORE_FILE_ENV = 'OPENCODE_MULTI_AUTH_STORE_FILE'
const LEGACY_DEFAULT_STORE_FILE = 'accounts.json'
const LEGACY_DEFAULT_STORE_DIR = path.join(os.homedir(), '.config', 'opencode-multi-auth')
const DEFAULT_STORE_DIR = path.join(os.homedir(), '.config', 'opencode-enhancer')
const DEFAULT_STORE_FILE = 'settings.json'

let storeCache: AccountStore | null = null
let storeCacheDirty = false
let storeCacheFileMtimeMs: number | null = null
let storeFlushTimer: ReturnType<typeof setTimeout> | null = null
const STORE_FLUSH_INTERVAL_MS = 2_000
let storeLocationChecked = false

function getEnvPath(...keys: string[]): string | null {
	for (const key of keys) {
		const value = process.env[key]
		if (value && value.trim()) return path.resolve(value.trim())
	}
	return null
}

function movePathIfMissing(source: string, target: string): void {
	if (!fs.existsSync(source) || fs.existsSync(target)) return
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
	fs.renameSync(source, target)
}

function migrateStoreArtifacts(sourceDir: string, sourceFile: string, targetDir: string, targetFile: string): void {
	for (const suffix of ['', '.bak', '.lkg']) {
		movePathIfMissing(
			path.join(sourceDir, `${sourceFile}${suffix}`),
			path.join(targetDir, `${targetFile}${suffix}`),
		)
	}
}

function migrateLegacyStoreLocation(): void {
	if (storeLocationChecked) return
	storeLocationChecked = true

	if (getEnvPath(STORE_DIR_ENV, LEGACY_STORE_DIR_ENV, STORE_FILE_ENV, LEGACY_STORE_FILE_ENV)) {
		return
	}

	if (fs.existsSync(LEGACY_DEFAULT_STORE_DIR) && !fs.existsSync(DEFAULT_STORE_DIR)) {
		try {
			fs.renameSync(LEGACY_DEFAULT_STORE_DIR, DEFAULT_STORE_DIR)
		} catch {
			// Fall back to moving individual store artifacts.
		}
	}

	migrateStoreArtifacts(DEFAULT_STORE_DIR, LEGACY_DEFAULT_STORE_FILE, DEFAULT_STORE_DIR, DEFAULT_STORE_FILE)

	if (!fs.existsSync(LEGACY_DEFAULT_STORE_DIR)) return

	migrateStoreArtifacts(LEGACY_DEFAULT_STORE_DIR, LEGACY_DEFAULT_STORE_FILE, DEFAULT_STORE_DIR, DEFAULT_STORE_FILE)
}

function getStoreDir(): string {
	migrateLegacyStoreLocation()
	const override = getEnvPath(STORE_DIR_ENV, LEGACY_STORE_DIR_ENV)
	if (override) return override
	return DEFAULT_STORE_DIR
}

function getStoreFile(): string {
	migrateLegacyStoreLocation()
	const override = getEnvPath(STORE_FILE_ENV, LEGACY_STORE_FILE_ENV)
	if (override) return override
	return path.join(getStoreDir(), DEFAULT_STORE_FILE)
}

const STORE_ENV_PASSPHRASE = 'OPENCODE_ENHANCER_STORE_PASSPHRASE'
const LEGACY_STORE_ENV_PASSPHRASE = 'CODEX_SOFT_STORE_PASSPHRASE'
const CURRENT_STORE_VERSION = 2

type EncryptedStoreFile = {
	encrypted: true
	version: number
	salt: string
	iv: string
	tag: string
	data: string
}

type StoreFileV1 = {
	accounts: Record<string, AccountCredentials>
	activeAlias: string | null
	rotationIndex: number
	lastRotation: number
}

type StoreFileV2 = StoreFileV1 & {
	version: 2
	removedAccounts?: RemovedAccountIdentity[]
	forcedAlias?: string | null
	forcedUntil?: number | null
	previousRotationStrategy?: string | null
	forcedBy?: string | null
	rotationStrategy?: 'round-robin' | 'least-used' | 'random' | 'weighted-round-robin' | 'usage-priority'
	settings?: Partial<RotationSettings>
	force?: {
		forcedAlias: string | null
		forcedUntil: number | null
		previousRotationStrategy: string | null
		forcedBy: string | null
	}
}

type AccountIdentity = Pick<AccountCredentials, 'accountId' | 'accountUserId' | 'userId' | 'email'>

let storeLocked = false
let lastStoreError: string | null = null
let lastStoreEncrypted = false
let writeLock = false
let writeLockQueue: Array<() => void> = []

function getStoreFileMtimeMs(): number | null {
	try {
		const file = getStoreFile()
		return fs.existsSync(file) ? fs.statSync(file).mtimeMs : null
	} catch {
		return null
	}
}

function ensureDir(): void {
	const dir = getStoreDir()
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
	}
}

function emptyStore(): AccountStore {
	return {
		version: CURRENT_STORE_VERSION,
		accounts: {},
		removedAccounts: [],
		activeAlias: null,
		rotationIndex: 0,
		lastRotation: Date.now(),
	}
}

function normalizeIdentityValue(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined
	const normalized = value.trim()
	return normalized || undefined
}

function normalizeIdentityEmail(value: unknown): string | undefined {
	const normalized = normalizeIdentityValue(value)
	return normalized ? normalized.toLowerCase() : undefined
}

function buildRemovedAccountIdentity(
	account: AccountIdentity,
	removedAt: number = Date.now(),
): RemovedAccountIdentity | null {
	const identity: RemovedAccountIdentity = {
		accountId: normalizeIdentityValue(account.accountId),
		accountUserId: normalizeIdentityValue(account.accountUserId),
		userId: normalizeIdentityValue(account.userId),
		email: normalizeIdentityEmail(account.email),
		removedAt,
	}

	if (!identity.accountId && !identity.accountUserId && !identity.userId && !identity.email) {
		return null
	}

	return identity
}

function matchesRemovedAccountIdentity(removed: RemovedAccountIdentity, account: AccountIdentity): boolean {
	const accountId = normalizeIdentityValue(account.accountId)
	const accountUserId = normalizeIdentityValue(account.accountUserId)
	const userId = normalizeIdentityValue(account.userId)
	const email = normalizeIdentityEmail(account.email)

	return Boolean(
		(removed.accountUserId && accountUserId && removed.accountUserId === accountUserId) ||
		(removed.userId && userId && removed.userId === userId) ||
		(removed.accountId && accountId && removed.accountId === accountId) ||
		(removed.email && email && removed.email === email),
	)
}

function validateRemovedAccountIdentity(value: any): RemovedAccountIdentity | null {
	const identity = buildRemovedAccountIdentity(
		{
			accountId: value?.accountId,
			accountUserId: value?.accountUserId,
			userId: value?.userId,
			email: value?.email,
		},
		typeof value?.removedAt === 'number' ? value.removedAt : Date.now(),
	)
	return identity
}

function getPassphrase(): string | null {
	const value = process.env[STORE_ENV_PASSPHRASE] || process.env[LEGACY_STORE_ENV_PASSPHRASE]
	return value && value.trim().length > 0 ? value : null
}

function isEncryptedFile(payload: any): payload is EncryptedStoreFile {
	return Boolean(payload && payload.encrypted === true && typeof payload.data === 'string')
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
	return crypto.scryptSync(passphrase, salt, 32)
}

function encryptStore(store: AccountStore, passphrase: string): EncryptedStoreFile {
	const salt = crypto.randomBytes(16)
	const iv = crypto.randomBytes(12)
	const key = deriveKey(passphrase, salt)
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
	const serialized = JSON.stringify(store)
	const encrypted = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()])
	const tag = cipher.getAuthTag()
	return {
		encrypted: true,
		version: CURRENT_STORE_VERSION,
		salt: salt.toString('base64'),
		iv: iv.toString('base64'),
		tag: tag.toString('base64'),
		data: encrypted.toString('base64'),
	}
}

function decryptStore(file: EncryptedStoreFile, passphrase: string): AccountStore {
	const salt = Buffer.from(file.salt, 'base64')
	const iv = Buffer.from(file.iv, 'base64')
	const tag = Buffer.from(file.tag, 'base64')
	const data = Buffer.from(file.data, 'base64')
	const key = deriveKey(passphrase, salt)
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
	decipher.setAuthTag(tag)
	const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
	return JSON.parse(decrypted) as AccountStore
}

function validateAccount(acc: any, alias: string): AccountCredentials | null {
	if (!acc || typeof acc !== 'object') return null
	if (typeof acc.accessToken !== 'string' || !acc.accessToken) return null
	if (typeof acc.refreshToken !== 'string' || !acc.refreshToken) return null
	if (typeof acc.expiresAt !== 'number') return null

	const rateLimitHistory = Array.isArray(acc.rateLimitHistory)
		? acc.rateLimitHistory.filter((entry: any) =>
				hasMeaningfulRateLimits({
					fiveHour: entry?.fiveHour,
					weekly: entry?.weekly,
				}),
			)
		: undefined
	const rateLimits = hasMeaningfulRateLimits(acc.rateLimits) ? acc.rateLimits : undefined

	return {
		alias,
		accessToken: acc.accessToken,
		refreshToken: acc.refreshToken,
		idToken: typeof acc.idToken === 'string' ? acc.idToken : undefined,
		accountId: typeof acc.accountId === 'string' ? acc.accountId : undefined,
		accountUserId: typeof acc.accountUserId === 'string' ? acc.accountUserId : undefined,
		userId: typeof acc.userId === 'string' ? acc.userId : undefined,
		subscriptionActiveUntil:
			typeof acc.subscriptionActiveUntil === 'number' ? acc.subscriptionActiveUntil : undefined,
		expiresAt: acc.expiresAt,
		email: typeof acc.email === 'string' ? acc.email : undefined,
		name: typeof acc.name === 'string' ? acc.name : undefined,
		lastRefresh: typeof acc.lastRefresh === 'string' ? acc.lastRefresh : undefined,
		lastSeenAt: typeof acc.lastSeenAt === 'number' ? acc.lastSeenAt : undefined,
		lastActiveUntil: typeof acc.lastActiveUntil === 'number' ? acc.lastActiveUntil : undefined,
		lastUsed: typeof acc.lastUsed === 'number' ? acc.lastUsed : undefined,
		usageCount: typeof acc.usageCount === 'number' ? acc.usageCount : 0,
		rateLimitedUntil: typeof acc.rateLimitedUntil === 'number' ? acc.rateLimitedUntil : undefined,
		modelUnsupportedUntil: typeof acc.modelUnsupportedUntil === 'number' ? acc.modelUnsupportedUntil : undefined,
		modelUnsupportedAt: typeof acc.modelUnsupportedAt === 'number' ? acc.modelUnsupportedAt : undefined,
		modelUnsupportedModel: typeof acc.modelUnsupportedModel === 'string' ? acc.modelUnsupportedModel : undefined,
		modelUnsupportedError: typeof acc.modelUnsupportedError === 'string' ? acc.modelUnsupportedError : undefined,
		workspaceDeactivatedUntil:
			typeof acc.workspaceDeactivatedUntil === 'number' ? acc.workspaceDeactivatedUntil : undefined,
		workspaceDeactivatedAt: typeof acc.workspaceDeactivatedAt === 'number' ? acc.workspaceDeactivatedAt : undefined,
		workspaceDeactivatedError:
			typeof acc.workspaceDeactivatedError === 'string' ? acc.workspaceDeactivatedError : undefined,
		authInvalid: typeof acc.authInvalid === 'boolean' ? acc.authInvalid : undefined,
		authInvalidatedAt: typeof acc.authInvalidatedAt === 'number' ? acc.authInvalidatedAt : undefined,
		enabled: typeof acc.enabled === 'boolean' ? acc.enabled : undefined,
		disabledAt: typeof acc.disabledAt === 'number' ? acc.disabledAt : undefined,
		disabledBy: typeof acc.disabledBy === 'string' ? acc.disabledBy : undefined,
		disableReason: typeof acc.disableReason === 'string' ? acc.disableReason : undefined,
		rateLimits,
		rateLimitHistory: rateLimitHistory && rateLimitHistory.length > 0 ? rateLimitHistory : undefined,
		limitStatus: typeof acc.limitStatus === 'string' ? acc.limitStatus : undefined,
		limitError: typeof acc.limitError === 'string' ? acc.limitError : undefined,
		lastLimitProbeAt: typeof acc.lastLimitProbeAt === 'number' ? acc.lastLimitProbeAt : undefined,
		lastLimitErrorAt: typeof acc.lastLimitErrorAt === 'number' ? acc.lastLimitErrorAt : undefined,
		limitsConfidence:
			acc.limitsConfidence === 'fresh' ||
			acc.limitsConfidence === 'stale' ||
			acc.limitsConfidence === 'error' ||
			acc.limitsConfidence === 'unknown'
				? acc.limitsConfidence
				: undefined,
		tags: Array.isArray(acc.tags) ? acc.tags : undefined,
		notes: typeof acc.notes === 'string' ? acc.notes : undefined,
		source: acc.source === 'opencode' || acc.source === 'codex' ? acc.source : undefined,
	}
}

function validateStore(data: any): AccountStore | null {
	if (!data || typeof data !== 'object') return null
	const force = data.force && typeof data.force === 'object' ? data.force : null

	const accounts: Record<string, AccountCredentials> = {}
	const rawAccounts = data.accounts
	if (rawAccounts && typeof rawAccounts === 'object') {
		for (const [alias, acc] of Object.entries(rawAccounts)) {
			const validated = validateAccount(acc, alias)
			if (validated) {
				accounts[alias] = validated
			}
		}
	}

	const removedAccounts = Array.isArray(data.removedAccounts)
		? data.removedAccounts
				.map((entry: any) => validateRemovedAccountIdentity(entry))
				.filter((entry: RemovedAccountIdentity | null): entry is RemovedAccountIdentity => Boolean(entry))
		: []

	return {
		version: typeof data.version === 'number' ? data.version : undefined,
		accounts,
		removedAccounts,
		activeAlias: typeof data.activeAlias === 'string' ? data.activeAlias : null,
		rotationIndex: typeof data.rotationIndex === 'number' ? data.rotationIndex : 0,
		lastRotation: typeof data.lastRotation === 'number' ? data.lastRotation : Date.now(),
		forcedAlias:
			typeof data.forcedAlias === 'string'
				? data.forcedAlias
				: typeof force?.forcedAlias === 'string'
					? force.forcedAlias
					: null,
		forcedUntil:
			typeof data.forcedUntil === 'number'
				? data.forcedUntil
				: typeof force?.forcedUntil === 'number'
					? force.forcedUntil
					: null,
		previousRotationStrategy:
			typeof data.previousRotationStrategy === 'string'
				? data.previousRotationStrategy
				: typeof force?.previousRotationStrategy === 'string'
					? force.previousRotationStrategy
					: null,
		forcedBy:
			typeof data.forcedBy === 'string'
				? data.forcedBy
				: typeof force?.forcedBy === 'string'
					? force.forcedBy
					: null,
		rotationStrategy: data.rotationStrategy ?? data.settings?.rotationStrategy ?? 'usage-priority',
		settings: sanitizeRotationSettings(data.settings),
	}
}

function migrateV1toV2(data: StoreFileV1): StoreFileV2 {
	return {
		...data,
		version: 2,
		removedAccounts: [],
		forcedAlias: null,
		forcedUntil: null,
		previousRotationStrategy: null,
		forcedBy: null,
		rotationStrategy: 'usage-priority',
		settings: {
			rotationStrategy: 'usage-priority',
		},
	}
}

function migrateStore(data: any): AccountStore | null {
	if (!data || typeof data !== 'object') return null

	const version = typeof data.version === 'number' ? data.version : 1

	if (version > CURRENT_STORE_VERSION) {
		console.warn(
			`[enhancer] Store version ${version} is newer than supported ${CURRENT_STORE_VERSION}. Proceeding with caution.`,
		)
		return validateStore(data)
	}

	let migrated: any = data
	if (version === 1) {
		migrated = migrateV1toV2(data as StoreFileV1)
		console.log('[enhancer] Migrated store from v1 to v2')
	}

	return validateStore(migrated)
}

function getLastKnownGoodPath(): string {
	return `${getStoreFile()}.lkg`
}

function saveLastKnownGood(store: AccountStore): void {
	// Avoid writing plaintext snapshots when store encryption is enabled.
	if (getPassphrase()) {
		return
	}

	const lkgPath = getLastKnownGoodPath()
	try {
		fs.writeFileSync(lkgPath, JSON.stringify(store, null, 2), { mode: 0o600 })
	} catch {
		// ignore
	}
}

function loadLastKnownGood(): AccountStore | null {
	const lkgPath = getLastKnownGoodPath()
	if (!fs.existsSync(lkgPath)) return null
	try {
		const data = fs.readFileSync(lkgPath, 'utf-8')
		const parsed = JSON.parse(data)
		return validateStore(parsed)
	} catch {
		return null
	}
}

async function acquireWriteLock(): Promise<void> {
	if (!writeLock) {
		writeLock = true
		return
	}
	return new Promise(resolve => {
		writeLockQueue.push(resolve)
	})
}

function releaseWriteLock(): void {
	const next = writeLockQueue.shift()
	if (next) {
		next()
	} else {
		writeLock = false
	}
}

function buildSnapshot(window?: {
	remaining?: number
	limit?: number
	resetAt?: number
}): RateLimitSnapshot | undefined {
	if (!window) return undefined
	return {
		remaining: window.remaining,
		limit: window.limit,
		resetAt: window.resetAt,
	}
}

function buildHistoryEntry(rateLimits?: { fiveHour?: any; weekly?: any }): RateLimitHistoryEntry | null {
	if (!hasMeaningfulRateLimits(rateLimits)) return null
	const updatedAtValues = [rateLimits?.fiveHour?.updatedAt, rateLimits?.weekly?.updatedAt].filter(
		(value): value is number => typeof value === 'number',
	)
	const at = updatedAtValues.length > 0 ? Math.max(...updatedAtValues) : Date.now()
	return {
		at,
		fiveHour: buildSnapshot(rateLimits?.fiveHour),
		weekly: buildSnapshot(rateLimits?.weekly),
	}
}

function appendHistory(
	history: RateLimitHistoryEntry[] | undefined,
	entry: RateLimitHistoryEntry,
): RateLimitHistoryEntry[] {
	const next = history ? [...history] : []
	const last = next[next.length - 1]
	const same =
		last &&
		last.fiveHour?.remaining === entry.fiveHour?.remaining &&
		last.weekly?.remaining === entry.weekly?.remaining &&
		last.fiveHour?.resetAt === entry.fiveHour?.resetAt &&
		last.weekly?.resetAt === entry.weekly?.resetAt
	if (!same) {
		next.push(entry)
	}
	if (next.length > 160) {
		return next.slice(next.length - 160)
	}
	return next
}

export function loadStore(): AccountStore {
	storeLocked = false
	lastStoreError = null
	lastStoreEncrypted = false

	const cachedMtimeMs = getStoreFileMtimeMs()
	if (storeCache && !storeLocked && (storeCacheDirty || storeCacheFileMtimeMs === cachedMtimeMs)) {
		return storeCache
	}

	ensureDir()
	const file = getStoreFile()
	if (fs.existsSync(file)) {
		try {
			const data = fs.readFileSync(file, 'utf-8')
			const parsed = JSON.parse(data)
			if (isEncryptedFile(parsed)) {
				lastStoreEncrypted = true
				const passphrase = getPassphrase()
				if (!passphrase) {
					storeLocked = true
					lastStoreError = `Store is encrypted. Set ${STORE_ENV_PASSPHRASE} to unlock.`
					return emptyStore()
				}
				try {
					const decrypted = decryptStore(parsed, passphrase)
					const validated = validateStore(decrypted)
					if (validated) {
						saveLastKnownGood(validated)
						storeCache = validated
						storeCacheFileMtimeMs = getStoreFileMtimeMs()
						return validated
					}
					storeLocked = true
					lastStoreError = 'Store validation failed after decryption.'
					const lkg = loadLastKnownGood()
					if (lkg) {
						console.warn('[enhancer] Restored from last-known-good snapshot')
						storeCache = lkg
						storeCacheFileMtimeMs = getStoreFileMtimeMs()
						return lkg
					}
					return emptyStore()
				} catch (err) {
					storeLocked = true
					lastStoreError = 'Failed to decrypt store. Check passphrase.'
					console.error('[enhancer] Failed to decrypt store:', err)
					return emptyStore()
				}
			}

			const migrated = migrateStore(parsed)
			if (migrated) {
				saveLastKnownGood(migrated)
				storeCache = migrated
				storeCacheFileMtimeMs = getStoreFileMtimeMs()
				return migrated
			}

			storeLocked = true
			lastStoreError = 'Store validation failed.'
			console.error('[enhancer] Store validation failed')

			const lkg = loadLastKnownGood()
			if (lkg) {
				console.warn('[enhancer] Restored from last-known-good snapshot')
				storeCache = lkg
				storeCacheFileMtimeMs = getStoreFileMtimeMs()
				return lkg
			}
			return emptyStore()
		} catch (err) {
			storeLocked = true
			lastStoreError = 'Failed to parse store. Store locked until fixed.'
			console.error('[enhancer] Failed to parse store:', err)

			const lkg = loadLastKnownGood()
			if (lkg) {
				console.warn('[enhancer] Restored from last-known-good snapshot')
				storeCache = lkg
				storeCacheFileMtimeMs = getStoreFileMtimeMs()
				return lkg
			}
		}
	}
	const empty = emptyStore()
	storeCache = empty
	storeCacheFileMtimeMs = null
	return empty
}

export function saveStore(store: AccountStore): void {
	storeCache = store
	storeCacheDirty = true
	scheduleFlush()
}

function loadStoreForWrite(): AccountStore {
	flushStoreToDisk()
	storeCache = null
	storeCacheDirty = false
	return loadStore()
}

function scheduleFlush(): void {
	if (storeFlushTimer) return
	storeFlushTimer = setTimeout(() => {
		storeFlushTimer = null
		flushStoreToDisk()
	}, STORE_FLUSH_INTERVAL_MS)
}

export function flushStoreToDisk(): void {
	if (!storeCacheDirty || !storeCache) return
	const store = storeCache
	storeCacheDirty = false

	ensureDir()
	if (storeLocked) {
		console.error('[enhancer] Store locked; refusing to overwrite encrypted file.')
		return
	}

	const file = getStoreFile()
	const passphrase = getPassphrase()
	const payload = passphrase ? encryptStore(store, passphrase) : store
	const json = JSON.stringify(payload, null, 2)

	try {
		if (fs.existsSync(file)) {
			fs.copyFileSync(file, `${file}.bak`)
			fs.chmodSync(`${file}.bak`, 0o600)
		}
	} catch {
		// ignore backup failures
	}

	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
	let fd: number | null = null

	try {
		fd = fs.openSync(tmp, 'w', 0o600)
		fs.writeFileSync(fd, json, { encoding: 'utf-8' })
		try {
			fs.fsyncSync(fd)
		} catch {
			// fsync not supported everywhere; best-effort
		}
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd)
			} catch {
				// ignore
			}
		}
	}

	try {
		fs.renameSync(tmp, file)
	} catch (err: any) {
		if (err?.code === 'EPERM' || err?.code === 'EEXIST') {
			try {
				fs.unlinkSync(file)
			} catch {
				// ignore
			}
			fs.renameSync(tmp, file)
		} else {
			try {
				fs.unlinkSync(tmp)
			} catch {
				// ignore
			}
			throw err
		}
	}

	try {
		const dirFd = fs.openSync(getStoreDir(), 'r')
		try {
			fs.fsyncSync(dirFd)
		} catch {
			// ignore
		}
		fs.closeSync(dirFd)
	} catch {
		// ignore
	}

	try {
		fs.chmodSync(file, 0o600)
	} catch {
		// ignore
	}

	storeCacheFileMtimeMs = getStoreFileMtimeMs()

	saveLastKnownGood(store)
}

export async function withWriteLock<T>(fn: () => T): Promise<T> {
	await acquireWriteLock()
	try {
		return fn()
	} finally {
		releaseWriteLock()
	}
}

export function getStoreDiagnostics(): {
	storeDir: string
	storeFile: string
	locked: boolean
	encrypted: boolean
	error: string | null
} {
	return {
		storeDir: getStoreDir(),
		storeFile: getStoreFile(),
		locked: storeLocked,
		encrypted: lastStoreEncrypted,
		error: lastStoreError,
	}
}

export function addAccount(
	alias: string,
	creds: Omit<AccountCredentials, 'alias' | 'usageCount'>,
	options?: { clearRemoved?: boolean },
): AccountStore {
	const store = loadStoreForWrite()
	const entry = buildHistoryEntry(creds.rateLimits)
	if (options?.clearRemoved && store.removedAccounts?.length) {
		store.removedAccounts = store.removedAccounts.filter(removed => !matchesRemovedAccountIdentity(removed, creds))
	}
	store.accounts[alias] = {
		...creds,
		alias,
		usageCount: 0,
		rateLimitHistory: entry ? [entry] : creds.rateLimitHistory,
	}
	if (!store.activeAlias) {
		store.activeAlias = alias
	}
	saveStore(store)
	flushStoreToDisk()
	return store
}

export function removeAccount(alias: string): AccountStore {
	const store = loadStoreForWrite()
	const removed = store.accounts[alias]
	const removedIdentity = removed ? buildRemovedAccountIdentity(removed) : null

	if (removedIdentity) {
		const existingRemoved = store.removedAccounts || []
		store.removedAccounts = [
			...existingRemoved.filter(entry => !matchesRemovedAccountIdentity(entry, removedIdentity)),
			removedIdentity,
		]
	}

	delete store.accounts[alias]
	if (store.activeAlias === alias) {
		const remaining = Object.keys(store.accounts)
		store.activeAlias = remaining[0] || null
	}
	saveStore(store)
	flushStoreToDisk()
	return store
}

export function isRemovedAccount(account: AccountIdentity): boolean {
	const store = loadStore()
	return (store.removedAccounts || []).some(removed => matchesRemovedAccountIdentity(removed, account))
}

export function updateAccount(alias: string, updates: Partial<AccountCredentials>): AccountStore {
	const store = loadStoreForWrite()
	if (store.accounts[alias]) {
		const current = store.accounts[alias]
		const next = { ...current, ...updates }
		if (updates.rateLimits || next.rateLimits) {
			const entry = buildHistoryEntry(next.rateLimits)
			if (entry) {
				next.rateLimitHistory = appendHistory(current.rateLimitHistory, entry)
			}
		}
		store.accounts[alias] = next
		saveStore(store)
		flushStoreToDisk()
	}
	return store
}

export function promoteSelectedAccount(
	previousAlias: string,
	nextAlias: string,
	now: number = Date.now(),
): AccountStore {
	if (previousAlias === nextAlias) {
		return setActiveAlias(nextAlias)
	}

	const store = loadStoreForWrite()
	const previousAccount = store.accounts[previousAlias]
	const nextAccount = store.accounts[nextAlias]

	if (!nextAccount) {
		return store
	}

	if (previousAccount) {
		updateAccount(previousAlias, {
			usageCount: Math.max(0, (previousAccount.usageCount || 0) - 1),
		})
	}

	updateAccount(nextAlias, {
		usageCount: (nextAccount.usageCount || 0) + 1,
		lastUsed: now,
	})

	return setActiveAlias(nextAlias)
}

export function setActiveAlias(alias: string | null): AccountStore {
	const store = loadStoreForWrite()
	const now = Date.now()
	const previousAlias = store.activeAlias

	if (alias === null) {
		store.activeAlias = null
	} else if (store.accounts[alias]) {
		if (previousAlias && previousAlias !== alias && store.accounts[previousAlias]) {
			store.accounts[previousAlias] = {
				...store.accounts[previousAlias],
				lastActiveUntil: now,
			}
		}

		store.activeAlias = alias
		store.accounts[alias] = {
			...store.accounts[alias],
			lastSeenAt: now,
			lastActiveUntil: undefined,
		}

		const aliases = Object.keys(store.accounts)
		const idx = aliases.indexOf(alias)
		if (idx >= 0) {
			store.rotationIndex = idx
		}
		store.lastRotation = now
	}
	saveStore(store)
	flushStoreToDisk()
	return store
}

export function getActiveAccount(): AccountCredentials | null {
	const store = loadStore()
	if (!store.activeAlias) return null
	return store.accounts[store.activeAlias] || null
}

export function listAccounts(): AccountCredentials[] {
	const store = loadStore()
	return Object.values(store.accounts)
}

export function getStorePath(): string {
	return getStoreFile()
}

export function getStoreStatus(): {
	locked: boolean
	encrypted: boolean
	error: string | null
} {
	const diag = getStoreDiagnostics()
	return { locked: diag.locked, encrypted: diag.encrypted, error: diag.error }
}

export function invalidateStoreCache(): void {
	storeCache = null
	storeCacheDirty = false
	storeCacheFileMtimeMs = null
	if (storeFlushTimer) {
		clearTimeout(storeFlushTimer)
		storeFlushTimer = null
	}
}
