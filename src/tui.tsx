import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { BoxRenderable, TextRenderable } from '@opentui/core'
import { existsSync, readFileSync, watchFile, unwatchFile } from 'node:fs'
import { fetchAllUsage } from './providers/index.js'
import { getAccountIdFromClaims, getEmailFromClaims, getNameFromClaims, syncCodexAuthFile } from './codex-auth.js'
import { decodeJwtPayload } from './jwt.js'
import { getAuthPath, getOAuthCredential, invalidateAuthCache } from './providers/auth.js'
import { updateAccount } from './store.js'

// ── File paths ──────────────────────────────────────────────────

function getStorePath(): string {
	const override =
		process.env.OPENCODE_ENHANCER_STORE_FILE?.trim() || process.env.OPENCODE_MULTI_AUTH_STORE_FILE?.trim()
	if (override) return override

	const dir =
		process.env.OPENCODE_ENHANCER_STORE_DIR?.trim() ||
		process.env.OPENCODE_MULTI_AUTH_STORE_DIR?.trim() ||
		`${process.env.HOME || '~'}/.config/opencode-enhancer`
	return `${dir}/settings.json`
}

// ── Data types (minimal mirrors for reading JSON) ───────────────

interface RateLimitWindow {
	limit?: number
	remaining?: number
	resetAt?: number
	updatedAt?: number
}

interface AccountRateLimits {
	fiveHour?: RateLimitWindow
	weekly?: RateLimitWindow
}

interface AccountData {
	alias: string
	email?: string
	name?: string
	accountId?: string
	accessToken?: string
	refreshToken?: string
	expiresAt?: number
	lastSeenAt?: number
	rateLimits?: AccountRateLimits
	authInvalid?: boolean
	enabled?: boolean
	rateLimitedUntil?: number
	planType?: string
}

interface StoreData {
	activeAlias: string | null
	accounts: Record<string, AccountData>
}

interface UsageWindow {
	utilization: number
	resetsAt?: number
	label: string
	remaining?: number
	entitlement?: number
}

interface QuotaBasedUsage {
	type: 'quotaBased'
	utilization: number
	windows: UsageWindow[]
	remaining?: number
	entitlement?: number
}

interface PayAsYouGoUsage {
	type: 'payAsYouGo'
	utilization: number
	used: number
	total: number
	remaining: number
}

type ProviderUsage = QuotaBasedUsage | PayAsYouGoUsage

interface ProviderAccountResult {
	label: string
	email?: string
	usage: ProviderUsage
	status: string
	error?: string
}

interface ProviderResult {
	providerId: string
	providerName: string
	status: string
	usage?: ProviderUsage
	accounts?: ProviderAccountResult[]
	error?: string
	fetchedAt: number
}

interface ModelSelection {
	providerID: string
	modelID: string
}

interface ModelState {
	recent?: ModelSelection[]
}

// ── Data reading ────────────────────────────────────────────────

function readJsonFile<T>(filePath: string): T | null {
	try {
		if (!existsSync(filePath)) return null
		const raw = readFileSync(filePath, 'utf-8')
		return JSON.parse(raw) as T
	} catch {
		return null
	}
}

function readStore(): StoreData | null {
	return readJsonFile<StoreData>(getStorePath())
}

// ── Usage formatting ────────────────────────────────────────────

function buildBar(pct: number, width: number = 8): string {
	const used = Math.max(0, Math.min(100, pct))
	const filled = Math.round((used / 100) * width)
	const empty = width - filled
	return '█'.repeat(filled) + '░'.repeat(empty)
}

function formatRemaining(remaining: number | undefined, limit: number | undefined): string {
	if (typeof remaining !== 'number') return ''
	if (typeof limit === 'number' && limit > 0) {
		return `${remaining}/${limit}`
	}
	return `${remaining}%`
}

function formatResetIn(resetAt: number | undefined): string {
	if (!resetAt) return ''
	const ms = resetAt - Date.now()
	if (ms <= 0) return 'now'
	const totalSeconds = Math.floor(ms / 1000)
	const days = Math.floor(totalSeconds / 86400)
	const hours = Math.floor(totalSeconds / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	if (days > 0) return `${days}d${hours % 24}h`
	if (hours > 0) return `${hours}h${minutes}m`
	return `${minutes}m`
}

function formatCacheAge(fetchedAt: number): string {
	const seconds = Math.floor((Date.now() - fetchedAt) / 1000)
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	return `${Math.floor(minutes / 60)}h ago`
}

function createUsageBox(
	renderer: TuiPlugin extends (api: infer Api, ...args: any[]) => any
		? Api extends { renderer: infer R }
			? R
			: never
		: never,
) {
	const box = new BoxRenderable(renderer, {
		flexDirection: 'column',
		gap: 0,
		paddingTop: 0,
		paddingBottom: 0,
	})
	return box
}

function updateUsageBox(
	box: BoxRenderable,
	renderer: TuiPlugin extends (api: infer Api, ...args: any[]) => any
		? Api extends { renderer: infer R }
			? R
			: never
		: never,
	lines: Array<{ text: string; color: unknown }>,
) {
	for (const child of [...box.getChildren()]) {
		box.remove(child.id)
	}

	for (const line of lines) {
		const text = new TextRenderable(renderer, {
			content: line.text,
			fg: line.color as any,
			wrapMode: 'none',
			truncate: false,
		})
		box.add(text)
	}

	box.requestRender()
}

// ── Resolve usage for the current provider ──────────────────────

interface UsageWindowDisplay {
	label: string
	utilization: number
	remaining?: number
	limit?: number
	resetsIn: string
}

interface UsageInfo {
	providerLabel: string
	accountLabel: string
	windows: UsageWindowDisplay[]
	cacheAge: string
}

interface SelectedProviderInfo {
	rawProviderId: string
	usageProviderId: string
	modelId: string
}

let lastSelectedModel: ModelSelection | null = null

function readSelectedModel(modelStatePath: string): ModelSelection | null {
	const state = readJsonFile<ModelState>(modelStatePath)
	const selected = state?.recent?.[0]
	if (!selected?.providerID || !selected.modelID) return lastSelectedModel
	lastSelectedModel = selected
	return selected
}

function normalizeUsageProviderId(providerId: string): string {
	const normalized = providerId.trim().toLowerCase()
	if (!normalized) return 'codex'
	if (normalized === 'openai' || normalized === 'codex') return 'codex'
	if (normalized === 'anthropic' || normalized === 'claude') return 'claude'
	if (normalized === 'google' || normalized === 'gemini') return 'gemini'
	if (normalized === 'github' || normalized === 'github-copilot' || normalized === 'copilot') {
		return 'copilot'
	}
	if (normalized === 'open-router' || normalized === 'openrouter') return 'openrouter'
	if (normalized === 'mini-max' || normalized === 'minimax') return 'minimax'
	if (normalized === 'nano-gpt' || normalized === 'nanogpt') return 'nanogpt'
	if (normalized === 'zai-coding-plan' || normalized === 'zai') return 'zai'
	return normalized
}

function resolveCurrentProvider(
	config: { model?: string },
	selectedModel: ModelSelection | null,
): SelectedProviderInfo {
	if (selectedModel) {
		return {
			rawProviderId: selectedModel.providerID,
			usageProviderId: normalizeUsageProviderId(selectedModel.providerID),
			modelId: selectedModel.modelID,
		}
	}

	const raw = config.model || ''
	const separatorIndex = raw.indexOf('/')
	const rawProviderId = separatorIndex >= 0 ? raw.slice(0, separatorIndex) : raw || 'openai'
	const modelId = separatorIndex >= 0 ? raw.slice(separatorIndex + 1) : raw
	return {
		rawProviderId,
		usageProviderId: normalizeUsageProviderId(rawProviderId),
		modelId,
	}
}

function syncActiveAliasFromOpenCodeAuth(): void {
	const credential = getOAuthCredential('openai')
	if (!credential?.access) return

	const claims = decodeJwtPayload(credential.access)
	const accountId = credential.accountId || getAccountIdFromClaims(claims)
	const email = getEmailFromClaims(claims)
	const name = getNameFromClaims(claims)
	const store = readStore()
	if (!store) return

	const match = Object.values(store.accounts).find(account => {
		if (account.accessToken === credential.access) return true
		if (credential.refresh && account.refreshToken === credential.refresh) return true
		if (accountId && account.accountId === accountId) return true
		if (email && account.email === email) return true
		return false
	})

	if (!match) return

	updateAccount(match.alias, {
		accessToken: credential.access,
		refreshToken: credential.refresh || match.refreshToken,
		expiresAt: credential.expires || match.expiresAt,
		accountId: accountId || match.accountId,
		email: email || match.email,
		name: name || match.name,
		lastSeenAt: Date.now(),
	})
}

function resolveCurrentCodexAccount(store: StoreData | null): AccountData | null {
	if (!store) return null

	if (store.activeAlias && store.accounts[store.activeAlias]) {
		return store.accounts[store.activeAlias]
	}

	const credential = getOAuthCredential('openai')
	if (credential?.access) {
		const claims = decodeJwtPayload(credential.access)
		const accountId = credential.accountId || getAccountIdFromClaims(claims)
		const email = getEmailFromClaims(claims)
		const matchedAccount = Object.values(store.accounts).find(account => {
			if (account.accessToken === credential.access) return true
			if (credential.refresh && account.refreshToken === credential.refresh) return true
			if (accountId && account.accountId === accountId) return true
			if (email && account.email === email) return true
			return false
		})
		if (matchedAccount) return matchedAccount
	}

	return Object.values(store.accounts)[0] || null
}

function toUsageWindows(usage: ProviderUsage): UsageWindowDisplay[] {
	if (usage.type === 'quotaBased') {
		return usage.windows.map(window => ({
			label: window.label,
			utilization: window.utilization,
			remaining: window.remaining,
			limit: window.entitlement,
			resetsIn: formatResetIn(window.resetsAt),
		}))
	}

	return [
		{
			label: 'credits',
			utilization: usage.utilization,
			remaining: usage.remaining,
			limit: usage.total,
			resetsIn: '',
		},
	]
}

function createUsageInfo(
	providerLabel: string,
	accountLabel: string,
	usage: ProviderUsage | undefined,
	fetchedAt: number | undefined,
): UsageInfo | null {
	if (!usage) return null
	const windows = toUsageWindows(usage)
	if (windows.length === 0) return null
	return {
		providerLabel,
		accountLabel,
		windows,
		cacheAge: fetchedAt ? formatCacheAge(fetchedAt) : '',
	}
}

function resolveCodexUsage(store: StoreData | null, result: ProviderResult | null): UsageInfo | null {
	if (!result || result.status !== 'ok') return null
	const preferredAccount = resolveCurrentCodexAccount(store)
	const selectedAccount =
		result.accounts?.find(
			account =>
				account.label === preferredAccount?.alias ||
				(preferredAccount?.email ? account.email === preferredAccount.email : false),
		) ||
		result.accounts?.find(account => account.status === 'ok') ||
		result.accounts?.[0]

	if (!selectedAccount || selectedAccount.status !== 'ok') return null

	return createUsageInfo('OpenAI Codex', selectedAccount.label, selectedAccount.usage, result.fetchedAt)
}

function resolveProviderUsage(result: ProviderResult | null): UsageInfo | null {
	if (!result || result.status !== 'ok') return null
	return createUsageInfo(result.providerName, '', result.usage, result.fetchedAt)
}

function getUsageForProvider(
	providerId: string,
	store: StoreData | null,
	result: ProviderResult | null,
): UsageInfo | null {
	if (providerId === 'codex' || providerId === '') {
		return resolveCodexUsage(store, result)
	}
	return resolveProviderUsage(result)
}

// ── TUI Plugin ──────────────────────────────────────────────────

const tui: TuiPlugin = async api => {
	const modelStatePath = `${api.state.path.state}/model.json`
	const storePath = getStorePath()
	const authPath = getAuthPath()
	let currentProvider = resolveCurrentProvider(
		api.state.config as { model?: string },
		readSelectedModel(modelStatePath),
	)
	let currentResult: ProviderResult | null = null
	let currentError: string | null = null
	let loading = true
	let refreshToken = 0
	let sidebarBox: BoxRenderable | null = null
	let currentTheme: {
		accent: unknown
		textMuted: unknown
		error: unknown
		warning: unknown
		success: unknown
	} | null = null

	const buildLines = (theme: {
		accent: unknown
		textMuted: unknown
		error: unknown
		warning: unknown
		success: unknown
	}) => {
		const store = readStore()
		const info = getUsageForProvider(currentProvider.usageProviderId, store, currentResult)
		if (!info) {
			if (loading) {
				return [
					{ text: 'Usage', color: theme.accent },
					{ text: `Loading ${currentProvider.rawProviderId}...`, color: theme.textMuted },
				]
			}
			if (currentError) {
				return [
					{ text: 'Usage', color: theme.accent },
					{ text: `${currentProvider.rawProviderId}: ${currentError}`, color: theme.textMuted },
				]
			}
			return [
				{ text: 'Usage', color: theme.accent },
				{
					text: `No usage data for ${currentProvider.rawProviderId || 'current provider'}`,
					color: theme.textMuted,
				},
			]
		}

		const lines: Array<{ text: string; color: unknown }> = []
		let header = 'Usage'
		if (info.accountLabel) header += ` ${info.accountLabel}`
		if (info.providerLabel) header += ` ${info.providerLabel}`
		lines.push({ text: header, color: theme.accent })

		if (currentProvider.usageProviderId === 'codex') {
			lines.push({
				text: `active ${info.accountLabel}`,
				color: theme.textMuted,
			})
		}

		for (const window of info.windows) {
			const pct = Math.round(window.utilization)
			const bar = buildBar(pct, 8)
			const remaining = formatRemaining(window.remaining, window.limit)
			const resetStr = window.resetsIn ? ` reset:${window.resetsIn}` : ''
			let text = `${window.label.padEnd(7)}${bar} ${pct}%`
			if (remaining) text += ` ${remaining}`
			if (resetStr) text += resetStr
			lines.push({
				text,
				color: pct >= 80 ? theme.error : pct >= 50 ? theme.warning : theme.success,
			})
		}

		return lines
	}

	const renderCurrentState = () => {
		if (!sidebarBox || !currentTheme) return
		updateUsageBox(sidebarBox, api.renderer, buildLines(currentTheme))
	}

	const refreshCodexSelection = () => {
		if (currentProvider.usageProviderId !== 'codex') return
		invalidateAuthCache()
		syncActiveAliasFromOpenCodeAuth()
		renderCurrentState()
	}

	const refreshUsage = async () => {
		const token = ++refreshToken
		currentProvider = resolveCurrentProvider(
			api.state.config as { model?: string },
			readSelectedModel(modelStatePath),
		)
		loading = true
		currentError = null
		currentResult = null
		renderCurrentState()

		if (currentProvider.usageProviderId === 'codex') {
			invalidateAuthCache()
			syncCodexAuthFile({ setActiveAlias: false, allowAdd: false })
			syncActiveAliasFromOpenCodeAuth()
		}

		try {
			const results = await fetchAllUsage({ providerIds: [currentProvider.usageProviderId] })
			if (token !== refreshToken) return
			currentResult = results[0] || null
			currentError =
				currentResult && currentResult.status !== 'ok'
					? currentResult.error || currentResult.status.replace(/_/g, ' ')
					: null
		} catch (error) {
			if (token !== refreshToken) return
			currentResult = null
			currentError = error instanceof Error ? error.message : String(error)
		} finally {
			if (token !== refreshToken) return
			loading = false
			renderCurrentState()
		}
	}

	const selectedProviderPoll = setInterval(() => {
		const nextProvider = resolveCurrentProvider(
			api.state.config as { model?: string },
			readSelectedModel(modelStatePath),
		)
		if (
			nextProvider.rawProviderId !== currentProvider.rawProviderId ||
			nextProvider.modelId !== currentProvider.modelId
		) {
			void refreshUsage()
		}
	}, 1000)

	const refreshInterval = setInterval(() => {
		void refreshUsage()
	}, 60_000)
	if (existsSync(modelStatePath)) {
		watchFile(modelStatePath, { interval: 500 }, () => {
			void refreshUsage()
		})
	}
	if (existsSync(storePath)) {
		watchFile(storePath, { interval: 500 }, () => {
			refreshCodexSelection()
		})
	}
	if (existsSync(authPath)) {
		watchFile(authPath, { interval: 500 }, () => {
			refreshCodexSelection()
		})
	}

	api.lifecycle.onDispose(() => {
		clearInterval(selectedProviderPoll)
		clearInterval(refreshInterval)
		if (existsSync(modelStatePath)) {
			unwatchFile(modelStatePath)
		}
		if (existsSync(storePath)) {
			unwatchFile(storePath)
		}
		if (existsSync(authPath)) {
			unwatchFile(authPath)
		}
	})
	void refreshUsage()

	api.slots.register({
		order: 50,
		slots: {
			sidebar_content(ctx, props) {
				currentTheme = ctx.theme.current
				if (!sidebarBox) {
					sidebarBox = createUsageBox(api.renderer)
				}
				renderCurrentState()
				return sidebarBox
			},
		},
	})
}

const plugin: TuiPluginModule & { id: string } = {
	id: 'opencode-enhancer-usage',
	tui,
}

export default plugin
export { tui }
