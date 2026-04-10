// CLI usage command: formatted table output for provider usage

import { fetchAllUsage, allProviders } from './providers/index.js'
import type { ProviderResult, ProviderAccountResult, ProviderUsage, UsageWindow } from './providers/types.js'
import { decodeJwtPayload } from './jwt.js'
import { loadStore } from './store.js'
import type { AccountCredentials } from './types.js'
import { readUsageCache, writeUsageCache } from './usage-cache.js'

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

function buildBar(pct: number, width = 8): string {
  const filled = Math.round((pct / 100) * width)
  const empty = width - filled
  const color = utilizationColor(pct)
  return `${color}${'█'.repeat(filled)}${c.dim}${'░'.repeat(empty)}${c.reset}`
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '')
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

interface TableLayout {
  providerWidth: number
  chartWidth: number
  planWidth: number
}

interface RenderContext {
  activeAlias: string | null
  codexPlansByAlias: Map<string, string>
}

const TABLE_INDENT = '  '
const COLUMN_GAP = '  '
const CHART_BAR_WIDTH = 6

function normalizeWindowLabel(label: string): string {
  return label.trim().toLowerCase()
}

function isStandardWindowLabel(label: string): boolean {
  const normalized = normalizeWindowLabel(label)
  return normalized === '5h' || normalized === 'weekly'
}

function findUsageWindow(usage: ProviderUsage, label: '5h' | 'weekly'): UsageWindow | undefined {
  if (usage.type !== 'quotaBased') return undefined
  return usage.windows.find((window) => normalizeWindowLabel(window.label) === label)
}

function formatChartCell(window: UsageWindow | undefined, width: number): string {
  if (!window) {
    return padRight(`${c.dim}—${c.reset}`, width)
  }

  const used = Math.round(window.utilization)
  const pctColor = utilizationColor(used)
  const pct = padLeft(`${pctColor}${used}%${c.reset}`, 4)
  return padRight(`${buildBar(window.utilization, CHART_BAR_WIDTH)} ${pct}`, width)
}

function abbreviateWindowLabel(label: string): string {
  const normalized = normalizeWindowLabel(label)
  if (normalized === 'weekly') return 'wk'
  return truncateText(label, 14)
}

function formatUsageDetails(usage: ProviderUsage): string {
  if (usage.type === 'payAsYouGo') {
    return `$${usage.used.toFixed(2)} / $${usage.total.toFixed(2)}`
  }

  const windows = usage.windows.filter((w) => w.label !== 'balance' && !w.label.startsWith('$'))
  const extraWindows = windows.filter((w) => !isStandardWindowLabel(w.label))
  const standardWindows = windows.filter((w) => isStandardWindowLabel(w.label))

  const parts = (extraWindows.length > 0 ? extraWindows : standardWindows)
    .slice(0, 3)
    .map((window) => {
      const used = Math.round(window.utilization)
      const left = Math.max(0, 100 - used)
      const color = utilizationColor(used)
      return `${c.dim}${abbreviateWindowLabel(window.label)}${c.reset} ${color}${used}${c.reset}${c.dim}/${c.reset}${color}${left}${c.reset}`
    })

  if (parts.length > 0) {
    return parts.join(` ${c.dim}·${c.reset} `)
  }

  const pctColor = utilizationColor(usage.utilization)
  return `${pctColor}${Math.round(usage.utilization)}%${c.reset}`
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
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
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
  for (const account of Object.values(store.accounts)) {
    const plan = getCodexPlanFromAccount(account)
    if (plan) {
      codexPlansByAlias.set(account.alias, plan)
    }
  }

  return {
    activeAlias: store.activeAlias,
    codexPlansByAlias,
  }
}

function hasAccountRows(result: ProviderResult): boolean {
  return Array.isArray(result.accounts) && result.accounts.length > 0
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
  const plain = stripAnsi(label).replace(/\s+\(active\)\s*$/, '').trim()
  return plain || undefined
}

function getPlanLabel(
  result: ProviderResult,
  usage: ProviderUsage | undefined,
  rawLabel: string | undefined,
  context: RenderContext,
  explicitPlan?: string
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

function formatPlanCell(plan: string | undefined, width: number): string {
  if (!plan) {
    return padRight(`${c.dim}—${c.reset}`, width)
  }
  return padRight(`${c.cyan}${truncateText(plan, width)}${c.reset}`, width)
}

function getTableLayout(results: ProviderResult[], context: RenderContext): TableLayout {
  const labels = results.flatMap((result) => [
    getProviderDisplayName(result),
    ...(result.accounts?.map((acc) => `  ${getDisplayLabel(result, acc.label, context)}`) ?? []),
  ])

  const providerWidth = clamp(
    Math.max(18, ...labels.map((label) => visibleLength(label))),
    18,
    34
  )

  const planLengths = results.flatMap((result) => {
    const plans: Array<string | undefined> = []
    if (!hasAccountRows(result)) {
      plans.push(getPlanLabel(result, result.usage, undefined, context, result.plan))
    }
    for (const account of result.accounts ?? []) {
      plans.push(getPlanLabel(result, account.usage, account.label, context, account.plan))
    }
    return plans.map((plan) => visibleLength(plan ?? '—'))
  })

  const planWidth = clamp(
    Math.max(10, ...planLengths),
    10,
    24
  )

  return {
    providerWidth,
    chartWidth: CHART_BAR_WIDTH + 1 + 4,
    planWidth,
  }
}

// ── Format a single result row ────────────────────────────────

function formatResultRow(
  result: ProviderResult,
  layout: TableLayout,
  context: RenderContext,
  labels?: { rawLabel?: string; displayLabel?: string }
): string {
  const rawLabel = labels?.rawLabel
  const displayLabel = labels?.displayLabel || getDisplayLabel(result, rawLabel, context)
  const name = padRight(displayLabel, layout.providerWidth)
  const combinedChartWidth = layout.chartWidth * 2 + COLUMN_GAP.length
  const tablePrefix = `${TABLE_INDENT}${name}${COLUMN_GAP}`

  if (result.status === 'not_configured') {
    return `${TABLE_INDENT}${c.dim}${name}${COLUMN_GAP}${padRight('not configured', combinedChartWidth + layout.planWidth + COLUMN_GAP.length + 6)}${c.reset}`
  }

  if (result.status === 'auth_expired') {
    return `${tablePrefix}${c.red}${padRight('auth expired', combinedChartWidth)}${c.reset}${COLUMN_GAP}${formatPlanCell(undefined, layout.planWidth)}${COLUMN_GAP}${c.dim}${result.error || ''}${c.reset}`
  }

  if (result.status === 'error') {
    return `${tablePrefix}${c.red}${padRight('error', combinedChartWidth)}${c.reset}${COLUMN_GAP}${formatPlanCell(undefined, layout.planWidth)}${COLUMN_GAP}${c.dim}${(result.error || '').slice(0, 50)}${c.reset}`
  }

  if (!result.usage) {
    return `${tablePrefix}${c.dim}no data${c.reset}`
  }

  const usage = result.usage
  const fiveHourChart = formatChartCell(findUsageWindow(usage, '5h'), layout.chartWidth)
  const weeklyChart = formatChartCell(findUsageWindow(usage, 'weekly'), layout.chartWidth)
  const planCell = formatPlanCell(getPlanLabel(result, usage, rawLabel, context, result.plan), layout.planWidth)

  if (usage.type === 'payAsYouGo') {
    return `${tablePrefix}${padRight(`${c.dim}—${c.reset}`, layout.chartWidth)}${COLUMN_GAP}${padRight(`${c.dim}—${c.reset}`, layout.chartWidth)}${COLUMN_GAP}${planCell}${COLUMN_GAP}${c.dim}—${c.reset}`
  }

  // Reset time: pick earliest reset
  const resets = usage.windows
    .filter((w) => w.resetsAt && w.resetsAt > Date.now())
    .sort((a, b) => (a.resetsAt || 0) - (b.resetsAt || 0))
  const resetStr = resets.length > 0 ? formatResetTime(resets[0].resetsAt) : `${c.dim}—${c.reset}`

  return `${tablePrefix}${fiveHourChart}${COLUMN_GAP}${weeklyChart}${COLUMN_GAP}${planCell}${COLUMN_GAP}${resetStr}`
}

function formatProviderHeaderRow(result: ProviderResult, layout: TableLayout): string {
  const name = padRight(getProviderDisplayName(result), layout.providerWidth)
  return `${TABLE_INDENT}${c.bold}${name}${c.reset}${COLUMN_GAP}${' '.repeat(layout.chartWidth)}${COLUMN_GAP}${' '.repeat(layout.chartWidth)}${COLUMN_GAP}${' '.repeat(layout.planWidth)}`
}

// ── Format account sub-rows ───────────────────────────────────

function formatAccountRows(result: ProviderResult, layout: TableLayout, context: RenderContext): string[] {
  if (!result.accounts || result.accounts.length === 0) return []

  return result.accounts.map((acc) => {
    const subLabel = `${TABLE_INDENT}${getDisplayLabel(result, acc.label, context)}`
    const subResult: ProviderResult = {
      providerId: result.providerId,
      providerName: acc.label,
      billingType: result.billingType,
      plan: acc.plan,
      status: acc.status,
      usage: acc.usage,
      error: acc.error,
      fetchedAt: result.fetchedAt,
    }
    return formatResultRow(subResult, layout, context, {
      rawLabel: acc.label,
      displayLabel: subLabel,
    })
  })
}

// ── Main command ──────────────────────────────────────────────

export interface UsageCommandOptions {
  provider?: string
  json?: boolean
  verbose?: boolean
  noCache?: boolean
}

export async function runUsageCommand(opts: UsageCommandOptions): Promise<void> {
  const providerIds = opts.provider ? [opts.provider] : undefined

  // Validate provider name
  if (opts.provider) {
    const valid = allProviders.map((p) => p.id)
    if (!valid.includes(opts.provider)) {
      console.error(
        `Unknown provider: ${opts.provider}\nAvailable: ${valid.join(', ')}`
      )
      process.exit(1)
    }
  }

  // Try cache first (unless --no-cache or --json)
  if (!opts.noCache && !opts.json) {
    const cached = readUsageCache()
    if (cached) {
      const filtered = providerIds
        ? cached.results.filter((r) => providerIds.includes(r.providerId))
        : cached.results
      renderTable(filtered, opts.verbose)
      return
    }
  }

  // Show spinner
  if (!opts.json) {
    process.stdout.write(`${c.dim}Fetching usage from ${providerIds ? providerIds.length : allProviders.length} providers...${c.reset}`)
  }

  const results = await fetchAllUsage({ providerIds })

  // Cache results
  writeUsageCache(results)

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
  const layout = getTableLayout(results, context)

  // Table output
  const configured = results.filter((r) => r.status !== 'not_configured')
  const notConfigured = results.filter((r) => r.status === 'not_configured')

  console.log()
  const header = `${TABLE_INDENT}${c.bold}${padRight('Provider', layout.providerWidth)}${COLUMN_GAP}${padRight('5h', layout.chartWidth)}${COLUMN_GAP}${padRight('Weekly', layout.chartWidth)}${COLUMN_GAP}${padRight('Plan', layout.planWidth)}${COLUMN_GAP}Resets${c.reset}`
  const divider = `${TABLE_INDENT}${c.dim}${'─'.repeat(visibleLength(header) - visibleLength(TABLE_INDENT))}${c.reset}`
  console.log(header)
  console.log(divider)

  for (const result of configured) {
    if (hasAccountRows(result)) {
      console.log(formatProviderHeaderRow(result, layout))
      const subRows = formatAccountRows(result, layout, context)
      for (const row of subRows) {
        console.log(row)
      }
      continue
    }

    console.log(formatResultRow(result, layout, context))
  }

  if (notConfigured.length > 0) {
    console.log(divider)
    for (const result of notConfigured) {
      console.log(formatResultRow(result, layout, context))
    }
  }

  console.log(divider)

  // Summary
  const okCount = configured.filter((r) => r.status === 'ok').length
  const errCount = configured.filter((r) => r.status === 'error' || r.status === 'auth_expired').length
  const notConfCount = notConfigured.length

  const parts: string[] = []
  if (okCount > 0) parts.push(`${c.green}${okCount} ok${c.reset}`)
  if (errCount > 0) parts.push(`${c.red}${errCount} error${c.reset}`)
  if (notConfCount > 0) parts.push(`${c.dim}${notConfCount} not configured${c.reset}`)

  console.log(`  ${parts.join(`  ${c.dim}·${c.reset}  `)}`)
  console.log()
}
