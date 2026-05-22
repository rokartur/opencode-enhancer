// CLI usage command: formatted table output for provider usage

import { fetchAllUsage, allProviders } from './providers/index.js'
import type { ProviderResult, ProviderUsage, UsageWindow } from './providers/types.js'
import { decodeJwtPayload } from './jwt.js'
import { loadStore, updateAccount } from './store.js'
import type { AccountCredentials } from './types.js'
import { readUsageCache, writeUsageCache } from './usage-cache.js'
import { getAccountIdFromClaims, getEmailFromClaims, getNameFromClaims, syncCodexAuthFile } from './codex-auth.js'
import { getOAuthCredential } from './providers/auth.js'
import { formatSubscriptionDaysLabel, getAccountSubscriptionActiveUntil } from './subscription.js'

// ── ANSI helpers ──────────────────────────────────────────────

const isColorSupported =
	process.env.FORCE_COLOR !== '0' &&
	process.env.NO_COLOR === undefined &&
	(process.stdout.isTTY || process.env.FORCE_COLOR !== undefined)

const c = {
	reset: isColorSupported ? '\x1b[0m' : '',
	bold: isColorSupported ? '\x1b[1m' : '',
	dim: isColorSupported ? '\x1b[2m' : '',
	red: isColorSupported ? '\x1b[31m' : '',
	green: isColorSupported ? '\x1b[32m' : '',
	yellow: isColorSupported ? '\x1b[33m' : '',
	blue: isColorSupported ? '\x1b[34m' : '',
	cyan: isColorSupported ? '\x1b[36m' : '',
	gray: isColorSupported ? '\x1b[90m' : '',
	white: isColorSupported ? '\x1b[37m' : '',
}

// ── Formatting helpers ────────────────────────────────────────

function formatDuration(ms: number): string {
	if (ms <= 0) return 'now'
	const totalSeconds = Math.floor(ms / 1000)
	const days = Math.floor(totalSeconds / 86400)
	const hours = Math.floor((totalSeconds % 86400) / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)

	if (days > 0) return `${days}d ${hours}h`
	if (hours > 0) return `${hours}h ${minutes}m`
	return `${minutes}m`
}

function formatResetTime(resetsAt: number | undefined): string {
	if (!resetsAt) return `${c.dim}—${c.reset}`
	const remaining = resetsAt - Date.now()
	if (remaining <= 0) return `${c.dim}now${c.reset}`
	return formatDuration(remaining)
}

function utilizationColor(pct: number): string {
	if (pct >= 80) return c.red
	if (pct >= 50) return c.yellow
	return c.green
}

function remainingColor(pct: number): string {
	if (pct <= 20) return c.red
	if (pct <= 50) return c.yellow
	return c.green
}

function parsePercent(value: string): number | undefined {
	const match = value.trim().match(/^(-?\d+(?:\.\d+)?)%$/)
	return match ? Number(match[1]) : undefined
}

function usedMetricColor(value: string): string {
	const pct = parsePercent(value)
	return pct === undefined ? c.red : utilizationColor(pct)
}

function leftMetricColor(value: string): string {
	const pct = parsePercent(value)
	return pct === undefined ? c.green : remainingColor(pct)
}

function stripAnsi(str: string): string {
	return str.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
}

function visibleLength(str: string): number {
	return stripAnsi(str).length
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max)
}

function truncateText(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str
	if (maxLen <= 1) return '…'
	return `${str.slice(0, maxLen - 1)}…`
}

function padRight(str: string, len: number): string {
	const pad = Math.max(0, len - visibleLength(str))
	return str + ' '.repeat(pad)
}

function padLeft(str: string, len: number): string {
	const pad = Math.max(0, len - visibleLength(str))
	return ' '.repeat(pad) + str
}

interface SummaryTableLayout {
	providerWidth: number
	statusWidth: number
	planWidth: number
	subscriptionWidth: number
	usedWidth: number
	leftWidth: number
	resetWidth: number
}

interface DetailTableLayout {
	labelWidth: number
	usedWidth: number
	leftWidth: number
	resetWidth: number
}

interface TextDetailLine {
	kind: 'text'
	text: string
}

interface StatsDetailLine {
	kind: 'stats'
	label: string
	used: string
	left: string
	reset: string
	usedColor?: string
	leftColor?: string
}

type DetailLine = TextDetailLine | StatsDetailLine

interface SummaryRow {
	provider: string
	status: 'ok' | 'error' | 'auth_expired' | 'not_configured'
	plan: string
	subscription: string
	used: string
	left: string
	reset: string
	usage?: ProviderUsage
	details: DetailLine[]
}

interface UsageTotals {
	usedLabel: string
	remainingLabel: string
}

interface RenderContext {
	activeAlias: string | null
	codexPlansByAlias: Map<string, string>
	codexSubscriptionsByAlias: Map<string, number>
}

const TABLE_INDENT = '  '
const COLUMN_GAP = '  '
function formatCount(value: number): string {
	if (!Number.isFinite(value)) return '0'
	if (Math.abs(value) >= 1000) {
		return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)
	}
	if (Number.isInteger(value)) return String(value)
	return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)
}

function formatBudgetCount(value: number): string {
	return new Intl.NumberFormat('en-US', {
		minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
		maximumFractionDigits: 1,
	}).format(value)
}

function getUsageWindows(usage: ProviderUsage): UsageWindow[] {
	if (usage.type !== 'quotaBased') return []
	return usage.windows.filter(window => window.label !== 'balance' && !window.label.startsWith('$'))
}

function getUsageTotals(usage: ProviderUsage): UsageTotals {
	if (usage.type === 'payAsYouGo') {
		return {
			usedLabel: `$${usage.used.toFixed(2)}`,
			remainingLabel: `$${usage.remaining.toFixed(2)}`,
		}
	}

	if (typeof usage.entitlement === 'number' && typeof usage.remaining === 'number' && usage.entitlement > 0) {
		const remaining = Math.max(0, usage.remaining)
		const used = usage.remaining < 0 ? usage.entitlement + Math.abs(usage.remaining) : usage.entitlement - remaining

		return {
			usedLabel: formatCount(used),
			remainingLabel: formatCount(remaining),
		}
	}

	const usedPct = Math.round(usage.utilization)
	const remainingPct = Math.max(0, 100 - usedPct)

	return {
		usedLabel: `${usedPct}%`,
		remainingLabel: `${remainingPct}%`,
	}
}

function hasAbsoluteQuotaTotals(usage: ProviderUsage): boolean {
	return (
		usage.type === 'quotaBased' &&
		typeof usage.entitlement === 'number' &&
		typeof usage.remaining === 'number' &&
		usage.entitlement > 0
	)
}

function createTextDetail(text: string): DetailLine {
	return { kind: 'text', text }
}

function createStatsDetail(detail: Omit<StatsDetailLine, 'kind'>): DetailLine {
	return { kind: 'stats', ...detail }
}

function getUsageWindowDetailLine(window: UsageWindow, usage?: ProviderUsage, index?: number): DetailLine {
	const pctUsed = Math.round(window.utilization)
	const pctLeft = Math.max(0, 100 - pctUsed)
	const aggregateTotals =
		usage && typeof index === 'number' && index === 0 && hasAbsoluteQuotaTotals(usage)
			? getUsageTotals(usage)
			: undefined
	const windowTotals = aggregateTotals ?? getWindowTotals(window)

	return createStatsDetail({
		label: window.label,
		used: windowTotals?.usedLabel ?? `${pctUsed}%`,
		left: windowTotals?.remainingLabel ?? `${pctLeft}%`,
		reset: stripAnsi(formatResetTime(window.resetsAt)),
		usedColor: usedMetricColor(windowTotals?.usedLabel ?? `${pctUsed}%`),
		leftColor: leftMetricColor(windowTotals?.remainingLabel ?? `${pctLeft}%`),
	})
}

function formatQuotaWindowDetails(window: UsageWindow, usage: ProviderUsage, index: number): DetailLine {
	return getUsageWindowDetailLine(window, usage, index)
}

function formatUsageDetailLines(usage: ProviderUsage): DetailLine[] {
	if (usage.type === 'payAsYouGo') {
		return [
			createStatsDetail({
				label: 'credits',
				used: `$${usage.used.toFixed(2)}`,
				left: `$${usage.remaining.toFixed(2)}`,
				reset: '—',
				usedColor: c.red,
				leftColor: c.green,
			}),
		]
	}

	return getUsageWindows(usage).map((window, index) => formatQuotaWindowDetails(window, usage, index))
}

function getStatusLabel(status: SummaryRow['status']): string {
	if (status === 'auth_expired') return 'auth expired'
	if (status === 'not_configured') return 'not configured'
	return status
}

function getStatusSymbol(status: SummaryRow['status']): string {
	if (status === 'ok') return '●'
	if (status === 'auth_expired') return '!'
	if (status === 'not_configured') return '○'
	return '✕'
}

function getStatusDisplayLabel(status: SummaryRow['status']): string {
	return `${getStatusSymbol(status)} ${getStatusLabel(status)}`
}

function formatStatusCell(status: SummaryRow['status'], width: number): string {
	const label = getStatusDisplayLabel(status)
	const color =
		status === 'ok' ? c.green : status === 'not_configured' ? c.dim : status === 'auth_expired' ? c.yellow : c.red

	return padRight(`${color}${label}${c.reset}`, width)
}

function formatMetricCell(value: string, width: number, color: string): string {
	return padLeft(`${color}${value}${c.reset}`, width)
}

function getDetailTableLayout(rows: SummaryRow[]): DetailTableLayout | undefined {
	const statsLines = rows
		.flatMap(row => row.details)
		.filter((detail): detail is StatsDetailLine => detail.kind === 'stats')

	if (statsLines.length === 0) return undefined

	return {
		labelWidth: clamp(
			Math.max(10, visibleLength('Window'), ...statsLines.map(detail => visibleLength(detail.label))),
			10,
			18,
		),
		usedWidth: Math.max(4, visibleLength('Used'), ...statsLines.map(detail => visibleLength(detail.used))),
		leftWidth: Math.max(4, visibleLength('Left'), ...statsLines.map(detail => visibleLength(detail.left))),
		resetWidth: Math.max(5, visibleLength('Reset'), ...statsLines.map(detail => visibleLength(detail.reset))),
	}
}

function getSummaryContentWidth(layout: SummaryTableLayout): number {
	return (
		layout.providerWidth +
		COLUMN_GAP.length +
		layout.statusWidth +
		COLUMN_GAP.length +
		layout.planWidth +
		COLUMN_GAP.length +
		layout.subscriptionWidth +
		COLUMN_GAP.length +
		layout.usedWidth +
		COLUMN_GAP.length +
		layout.leftWidth +
		COLUMN_GAP.length +
		layout.resetWidth
	)
}

function formatSummaryDivider(layout: SummaryTableLayout): string {
	return `${TABLE_INDENT}${c.dim}${'─'.repeat(getSummaryContentWidth(layout))}${c.reset}`
}

function formatSectionHeader(title: string, layout: SummaryTableLayout, meta?: string): string {
	const plainLabel = meta ? `${title} ${meta}` : title
	const fillerWidth = Math.max(0, getSummaryContentWidth(layout) - visibleLength(plainLabel) - 1)
	const label = meta ? `${c.bold}${title}${c.reset} ${c.dim}${meta}${c.reset}` : `${c.bold}${title}${c.reset}`

	if (fillerWidth === 0) return `${TABLE_INDENT}${label}`
	return `${TABLE_INDENT}${label} ${c.dim}${'─'.repeat(fillerWidth)}${c.reset}`
}

function formatNotConfiguredSection(results: ProviderResult[]): string[] {
	const names = results.map(result => getProviderDisplayName(result))
	if (names.length === 0) return []

	const labels = names.map(name => `${c.dim}○${c.reset} ${name}`)
	const widestLabel = Math.max(...labels.map(label => visibleLength(label)))
	const terminalWidth = Math.max(60, process.stdout.columns || 100)
	const availableWidth = Math.max(20, terminalWidth - visibleLength(TABLE_INDENT))
	const columnWidth = clamp(widestLabel, 16, 28)
	const columns = Math.max(
		1,
		Math.min(labels.length, Math.floor((availableWidth + COLUMN_GAP.length) / (columnWidth + COLUMN_GAP.length))),
	)
	const rows: string[] = []

	for (let index = 0; index < labels.length; index += columns) {
		const cells = labels.slice(index, index + columns).map(label => padRight(label, columnWidth))
		rows.push(`${TABLE_INDENT}${cells.join(COLUMN_GAP)}`.trimEnd())
	}

	return rows
}

function getPrimaryResetLabel(usage: ProviderUsage | undefined): string {
	if (!usage || usage.type !== 'quotaBased') return '—'

	const resets = usage.windows
		.filter(window => window.resetsAt && window.resetsAt > Date.now())
		.sort((a, b) => (a.resetsAt || 0) - (b.resetsAt || 0))

	return resets.length > 0 ? stripAnsi(formatResetTime(resets[0].resetsAt)) : '—'
}

function getWindowTotals(window: UsageWindow): UsageTotals | undefined {
	if (typeof window.entitlement !== 'number' || typeof window.remaining !== 'number' || window.entitlement <= 0) {
		return undefined
	}

	const remaining = Math.max(0, window.remaining)
	const used = window.remaining < 0 ? window.entitlement + Math.abs(window.remaining) : window.entitlement - remaining

	return {
		usedLabel: formatCount(used),
		remainingLabel: formatCount(remaining),
	}
}

function formatWindowDetail(window: UsageWindow): DetailLine {
	return getUsageWindowDetailLine(window)
}

function formatExtraBudgetDetail(window: UsageWindow): DetailLine | undefined {
	const parts: string[] = []

	if (window.extraBudgetEnabled !== undefined) {
		parts.push(window.extraBudgetEnabled ? `${c.green}enabled${c.reset}` : `${c.dim}disabled${c.reset}`)
	}

	if (typeof window.extraBudgetTotal === 'number') {
		parts.push(`${c.cyan}${formatBudgetCount(window.extraBudgetTotal)}${c.reset} ${c.dim}set${c.reset}`)
	}

	if (typeof window.extraBudgetUsed === 'number') {
		parts.push(`${c.red}${formatBudgetCount(window.extraBudgetUsed)}${c.reset} ${c.dim}spent${c.reset}`)
	}

	if (parts.length === 0) return undefined

	return createTextDetail(`${c.bold}extra budget${c.reset}: ${parts.join(` ${c.dim}·${c.reset} `)}`)
}

function getResultDetailLines(result: ProviderResult, verbose: boolean): DetailLine[] {
	if (result.status === 'error' || result.status === 'auth_expired') {
		return result.error ? [createTextDetail(result.error)] : []
	}

	if (result.status !== 'ok' || !result.usage) return []

	if (result.usage.type === 'payAsYouGo') {
		return verbose ? formatUsageDetailLines(result.usage) : []
	}

	const windows = getUsageWindows(result.usage)
	const extraBudgetDetails = windows
		.map(window => formatExtraBudgetDetail(window))
		.filter((detail): detail is DetailLine => !!detail)

	if (windows.length === 0) return []
	if (!verbose && windows.length === 1) return extraBudgetDetails

	return [...windows.map(window => formatWindowDetail(window)), ...extraBudgetDetails]
}

function buildSummaryRow(
	result: ProviderResult,
	context: RenderContext,
	verbose: boolean,
	labels?: { rawLabel?: string; displayLabel?: string },
): SummaryRow {
	const rawLabel = labels?.rawLabel
	const provider = labels?.displayLabel || getDisplayLabel(result, rawLabel, context)
	const plan = getPlanLabel(result, result.usage, rawLabel, context, result.plan) || '—'

	if (result.status !== 'ok' || !result.usage) {
		return {
			provider,
			status: result.status,
			plan,
			subscription: getSubscriptionLabel(result, rawLabel, context),
			used: '—',
			left: '—',
			reset: '—',
			details: getResultDetailLines(result, verbose),
		}
	}

	const totals = getUsageTotals(result.usage)

	return {
		provider,
		status: result.status,
		plan,
		subscription: getSubscriptionLabel(result, rawLabel, context),
		used: totals.usedLabel,
		left: totals.remainingLabel,
		reset: getPrimaryResetLabel(result.usage),
		usage: result.usage,
		details: getResultDetailLines(result, verbose),
	}
}

function getSummaryTableLayout(rows: SummaryRow[]): SummaryTableLayout {
	return {
		providerWidth: Math.max(
			18,
			...rows.map(row => visibleLength(row.provider)),
			visibleLength('Provider / Account'),
		),
		statusWidth: Math.max(
			14,
			...rows.map(row => visibleLength(getStatusDisplayLabel(row.status))),
			visibleLength('Status'),
		),
		planWidth: Math.max(10, ...rows.map(row => visibleLength(row.plan)), visibleLength('Plan')),
		subscriptionWidth: Math.max(
			11,
			...rows.map(row => visibleLength(row.subscription)),
			visibleLength('Sub expires'),
		),
		usedWidth: Math.max(8, ...rows.map(row => visibleLength(row.used)), visibleLength('Used')),
		leftWidth: Math.max(8, ...rows.map(row => visibleLength(row.left)), visibleLength('Left')),
		resetWidth: Math.max(8, ...rows.map(row => visibleLength(row.reset)), visibleLength('Reset')),
	}
}

function formatSummaryRow(row: SummaryRow, layout: SummaryTableLayout): string {
	const providerCell = padRight(row.provider, layout.providerWidth)
	const planCell = padRight(
		row.plan === '—' ? `${c.dim}—${c.reset}` : `${c.cyan}${row.plan}${c.reset}`,
		layout.planWidth,
	)
	const subscriptionCell = padLeft(
		row.subscription === '-' ? `${c.dim}-${c.reset}` : row.subscription,
		layout.subscriptionWidth,
	)
	const usedCell =
		row.status === 'ok'
			? formatMetricCell(row.used, layout.usedWidth, usedMetricColor(row.used))
			: padLeft(`${c.dim}${row.used}${c.reset}`, layout.usedWidth)
	const leftCell =
		row.status === 'ok'
			? formatMetricCell(row.left, layout.leftWidth, leftMetricColor(row.left))
			: padLeft(`${c.dim}${row.left}${c.reset}`, layout.leftWidth)
	const resetCell = padLeft(row.reset === '—' ? `${c.dim}—${c.reset}` : row.reset, layout.resetWidth)

	return `${TABLE_INDENT}${providerCell}${COLUMN_GAP}${formatStatusCell(row.status, layout.statusWidth)}${COLUMN_GAP}${planCell}${COLUMN_GAP}${subscriptionCell}${COLUMN_GAP}${usedCell}${COLUMN_GAP}${leftCell}${COLUMN_GAP}${resetCell}`
}

function formatDetailLine(
	detail: DetailLine,
	detailLayout: DetailTableLayout | undefined,
	prefix: string = '  ',
): string {
	if (detail.kind === 'text' || !detailLayout) {
		const text = detail.kind === 'text' ? detail.text : detail.label
		return `${TABLE_INDENT}${prefix}${c.dim}↳${c.reset} ${text}`
	}

	const labelCell = padRight(
		`${c.bold}${truncateText(detail.label, detailLayout.labelWidth)}${c.reset}`,
		detailLayout.labelWidth,
	)
	const usedCell = formatMetricCell(detail.used, detailLayout.usedWidth, detail.usedColor || c.red)
	const leftCell = formatMetricCell(detail.left, detailLayout.leftWidth, detail.leftColor || c.green)
	const resetCell = padLeft(detail.reset === '—' ? `${c.dim}—${c.reset}` : detail.reset, detailLayout.resetWidth)

	return `${TABLE_INDENT}${prefix}${c.dim}↳${c.reset} ${labelCell}${COLUMN_GAP}${c.dim}used${c.reset} ${usedCell}${COLUMN_GAP}${c.dim}left${c.reset} ${leftCell}${COLUMN_GAP}${c.dim}reset${c.reset} ${resetCell}`
}

function formatPlanValue(rawPlan: string | undefined): string | undefined {
	if (!rawPlan) return undefined
	const trimmed = rawPlan.trim()
	if (!trimmed) return undefined

	const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_')
	const knownPlans: Record<string, string> = {
		plus: 'Plus',
		pro: 'Pro',
		team: 'Team',
		business: 'Business',
		enterprise: 'Enterprise',
		free: 'Free',
		individual_pro: 'Individual Pro',
		individual_free: 'Individual Free',
		chatgpt_plus: 'Plus',
		chatgptplus: 'Plus',
		chatgpt_pro: 'Pro',
		chatgptpro: 'Pro',
		chatgpt_team: 'Team',
		chatgptteam: 'Team',
	}

	const known = knownPlans[normalized]
	if (known) return known

	return trimmed
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map(part => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ')
}

function extractPlanFromUsage(usage: ProviderUsage | undefined): string | undefined {
	if (!usage || usage.type !== 'quotaBased') return undefined
	for (const window of usage.windows) {
		const match = window.label.match(/\(([^()]+)\)/)
		if (match?.[1]) return formatPlanValue(match[1])
	}
	return undefined
}

function extractPlanFromProviderName(result: ProviderResult): string | undefined {
	if (result.providerId !== 'copilot') return undefined
	const match = result.providerName.match(/\(([^()]+)\)\s*$/)
	return match?.[1] ? formatPlanValue(match[1]) : undefined
}

function getProviderDisplayName(result: ProviderResult): string {
	if (result.providerId === 'copilot') {
		return result.providerName.replace(/\s*\([^()]+\)\s*$/, '')
	}
	return result.providerName
}

function getPlanTypeFromClaims(claims: Record<string, any> | null): string | undefined {
	if (!claims) return undefined
	const auth = claims['https://api.openai.com/auth'] as { chatgpt_plan_type?: string } | undefined
	return typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined
}

function getCodexPlanFromAccount(account: AccountCredentials): string | undefined {
	const explicitPlan = formatPlanValue(account.planType)
	if (explicitPlan) return explicitPlan

	const accessTokenPlan = formatPlanValue(getPlanTypeFromClaims(decodeJwtPayload(account.accessToken)))
	if (accessTokenPlan) return accessTokenPlan

	const idTokenPlan = formatPlanValue(getPlanTypeFromClaims(decodeJwtPayload(account.idToken || '')))
	if (idTokenPlan) return idTokenPlan

	return undefined
}

function getRenderContext(): RenderContext {
	const store = loadStore()
	const codexPlansByAlias = new Map<string, string>()
	const codexSubscriptionsByAlias = new Map<string, number>()
	for (const account of Object.values(store.accounts)) {
		const plan = getCodexPlanFromAccount(account)
		if (plan) {
			codexPlansByAlias.set(account.alias, plan)
		}

		const subscriptionActiveUntil = getAccountSubscriptionActiveUntil(account)
		if (subscriptionActiveUntil) {
			codexSubscriptionsByAlias.set(account.alias, subscriptionActiveUntil)
		}
	}

	return {
		activeAlias: store.activeAlias,
		codexPlansByAlias,
		codexSubscriptionsByAlias,
	}
}

function hasMultiAuthAccountRows(result: ProviderResult): boolean {
	return result.providerId === 'codex' && Array.isArray(result.accounts) && result.accounts.length > 0
}

function getAccountTreeLabel(
	result: ProviderResult,
	accountLabel: string,
	context: RenderContext,
	index: number,
	total: number,
): string {
	const branch = index === total - 1 ? '└─' : '├─'
	return `${branch} ${getDisplayLabel(result, accountLabel, context)}`
}

function getAccountDetailPrefix(index: number, total: number): string {
	return index === total - 1 ? '   ' : '│  '
}

function getDisplayLabel(result: ProviderResult, rawLabel: string | undefined, context: RenderContext): string {
	const label = rawLabel || getProviderDisplayName(result)
	if (result.providerId === 'codex' && rawLabel && rawLabel === context.activeAlias) {
		return `${rawLabel} ${c.cyan}(active)${c.reset}`
	}
	return label
}

function normalizePlanLookupLabel(label: string | undefined): string | undefined {
	if (!label) return undefined
	const plain = stripAnsi(label)
		.replace(/\s+\(active\)\s*$/, '')
		.trim()
	return plain || undefined
}

function getPlanLabel(
	result: ProviderResult,
	usage: ProviderUsage | undefined,
	rawLabel: string | undefined,
	context: RenderContext,
	explicitPlan?: string,
): string | undefined {
	const directPlan = formatPlanValue(explicitPlan || result.plan)
	if (directPlan) return directPlan

	if (result.providerId === 'codex') {
		const lookupLabel = normalizePlanLookupLabel(rawLabel)
		if (lookupLabel) {
			return context.codexPlansByAlias.get(lookupLabel)
		}
	}

	return extractPlanFromUsage(usage) || extractPlanFromProviderName(result)
}

function getSubscriptionLabel(result: ProviderResult, rawLabel: string | undefined, context: RenderContext): string {
	const direct = result.subscriptionActiveUntil
	if (direct) return formatSubscriptionDaysLabel(direct)

	if (result.providerId === 'codex') {
		const lookupLabel = normalizePlanLookupLabel(rawLabel)
		if (lookupLabel) {
			return formatSubscriptionDaysLabel(context.codexSubscriptionsByAlias.get(lookupLabel))
		}
	}

	return '-'
}

// ── Main command ──────────────────────────────────────────────

export interface UsageCommandOptions {
	provider?: string
	json?: boolean
	verbose?: boolean
	noCache?: boolean
}

function syncActiveAliasFromOpenCodeAuth(): void {
	const credential = getOAuthCredential('openai')
	if (!credential?.access) return

	const claims = decodeJwtPayload(credential.access)
	const accountId = credential.accountId || getAccountIdFromClaims(claims)
	const email = getEmailFromClaims(claims)
	const name = getNameFromClaims(claims)
	const store = loadStore()

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
		source: 'opencode',
	})
}

function isFullUsageCache(results: ProviderResult[]): boolean {
	const expectedProviderIds = new Set(allProviders.map(provider => provider.id))
	if (results.length !== expectedProviderIds.size) return false

	for (const result of results) {
		if (!expectedProviderIds.has(result.providerId)) {
			return false
		}
	}

	return true
}

export async function runUsageCommand(opts: UsageCommandOptions): Promise<void> {
	// `usage` should be effectively read-only for local account configuration:
	// refresh existing synced accounts, but do not resurrect accounts that the
	// user intentionally removed from the enhancer store.
	syncCodexAuthFile({ setActiveAlias: false, allowAdd: false })
	syncActiveAliasFromOpenCodeAuth()

	const providerIds = opts.provider ? [opts.provider] : undefined

	// Validate provider name
	if (opts.provider) {
		const valid = allProviders.map(p => p.id)
		if (!valid.includes(opts.provider)) {
			console.error(`Unknown provider: ${opts.provider}\nAvailable: ${valid.join(', ')}`)
			process.exit(1)
		}
	}

	// Try cache first (unless --no-cache or --json)
	if (!opts.noCache && !opts.json) {
		const cached = readUsageCache()
		if (cached) {
			if (!providerIds && !isFullUsageCache(cached.results)) {
				// Ignore stale partial caches left by older provider-scoped fetches.
			} else {
				const filtered = providerIds
					? cached.results.filter(r => providerIds.includes(r.providerId))
					: cached.results

				if (providerIds ? filtered.length > 0 : true) {
					renderTable(filtered, opts.verbose)
					return
				}
			}
		}
	}

	// Show spinner
	if (!opts.json) {
		process.stdout.write(
			`${c.dim}Fetching usage from ${providerIds ? providerIds.length : allProviders.length} providers...${c.reset}`,
		)
	}

	const results = await fetchAllUsage({ providerIds })

	// Cache results
	if (!providerIds) {
		writeUsageCache(results)
	}

	// Clear spinner line
	if (!opts.json) {
		process.stdout.write('\r' + ' '.repeat(60) + '\r')
	}

	// JSON output
	if (opts.json) {
		console.log(JSON.stringify(results, null, 2))
		return
	}

	renderTable(results, opts.verbose)
}

function renderTable(results: ProviderResult[], verbose: boolean = false): void {
	const context = getRenderContext()
	const configured = results.filter(r => r.status !== 'not_configured')
	const notConfigured = results.filter(r => r.status === 'not_configured')
	const summaryRows: SummaryRow[] = []

	for (const result of configured) {
		if (hasMultiAuthAccountRows(result)) {
			const accounts = result.accounts ?? []
			for (const [accountIndex, account] of accounts.entries()) {
				const subResult: ProviderResult = {
					providerId: result.providerId,
					providerName: account.label,
					billingType: result.billingType,
					plan: account.plan,
					subscriptionActiveUntil: account.subscriptionActiveUntil,
					status: account.status,
					usage: account.usage,
					error: account.error,
					fetchedAt: result.fetchedAt,
				}

				summaryRows.push(
					buildSummaryRow(subResult, context, verbose, {
						rawLabel: account.label,
						displayLabel: getAccountTreeLabel(
							result,
							account.label,
							context,
							accountIndex,
							accounts.length,
						),
					}),
				)
			}
			continue
		}

		summaryRows.push(buildSummaryRow(result, context, verbose))
	}

	const layout = getSummaryTableLayout(
		summaryRows.length > 0
			? summaryRows
			: [
					{
						provider: 'Provider / Account',
						status: 'ok',
						plan: 'Plan',
						subscription: 'Sub expires',
						used: 'Used',
						left: 'Left',
						reset: 'Reset',
						details: [],
					},
				],
	)
	const detailLayout = getDetailTableLayout(summaryRows)

	console.log()
	const header = `${TABLE_INDENT}${c.bold}${padRight('Provider / Account', layout.providerWidth)}${COLUMN_GAP}${padRight('Status', layout.statusWidth)}${COLUMN_GAP}${padRight('Plan', layout.planWidth)}${COLUMN_GAP}${padLeft('Sub expires', layout.subscriptionWidth)}${COLUMN_GAP}${padLeft('Used', layout.usedWidth)}${COLUMN_GAP}${padLeft('Left', layout.leftWidth)}${COLUMN_GAP}${padLeft('Reset', layout.resetWidth)}${c.reset}`
	const divider = formatSummaryDivider(layout)

	if (configured.length > 0) {
		console.log(header)
		console.log(divider)
	}

	for (const [resultIndex, result] of configured.entries()) {
		if (hasMultiAuthAccountRows(result)) {
			const accounts = result.accounts ?? []
			const accountCountLabel = `${accounts.length} account${accounts.length === 1 ? '' : 's'}`
			console.log(formatSectionHeader(getProviderDisplayName(result), layout, `(${accountCountLabel})`))

			for (const [accountIndex, account] of accounts.entries()) {
				const subResult: ProviderResult = {
					providerId: result.providerId,
					providerName: account.label,
					billingType: result.billingType,
					plan: account.plan,
					subscriptionActiveUntil: account.subscriptionActiveUntil,
					status: account.status,
					usage: account.usage,
					error: account.error,
					fetchedAt: result.fetchedAt,
				}

				const row = buildSummaryRow(subResult, context, verbose, {
					rawLabel: account.label,
					displayLabel: getAccountTreeLabel(result, account.label, context, accountIndex, accounts.length),
				})

				console.log(formatSummaryRow(row, layout))

				for (const detail of row.details) {
					console.log(
						formatDetailLine(detail, detailLayout, getAccountDetailPrefix(accountIndex, accounts.length)),
					)
				}
			}

			if (resultIndex < configured.length - 1) {
				console.log(divider)
			}

			continue
		}

		const row = buildSummaryRow(result, context, verbose)
		console.log(formatSummaryRow(row, layout))
		for (const detail of row.details) {
			console.log(formatDetailLine(detail, detailLayout))
		}

		if (resultIndex < configured.length - 1) {
			console.log(divider)
		}
	}

	if (notConfigured.length > 0) {
		console.log(divider)

		console.log(`${TABLE_INDENT}${c.bold}Not configured${c.reset} ${c.dim}(${notConfigured.length})${c.reset}`)
		for (const line of formatNotConfiguredSection(notConfigured)) {
			console.log(line)
		}

		console.log(divider)
	}

	if (configured.length > 0 && notConfigured.length === 0) {
		console.log(divider)
	}

	const okCount = configured.filter(r => r.status === 'ok').length
	const errCount = configured.filter(r => r.status === 'error' || r.status === 'auth_expired').length
	const notConfCount = notConfigured.length

	const parts: string[] = []
	if (okCount > 0) parts.push(`${c.green}${okCount} ok${c.reset}`)
	if (errCount > 0) parts.push(`${c.red}${errCount} error${c.reset}`)
	if (notConfCount > 0) parts.push(`${c.dim}${notConfCount} not configured${c.reset}`)

	console.log(`  ${parts.join(`  ${c.dim}·${c.reset}  `)}`)
	console.log()
}
