// CLI usage command: formatted table output for provider usage
import { fetchAllUsage, allProviders } from './providers/index.js';
import { loadStore } from './store.js';
import { readUsageCache, writeUsageCache } from './usage-cache.js';
// ── ANSI helpers ──────────────────────────────────────────────
const isColorSupported = process.env.FORCE_COLOR !== '0' &&
    process.env.NO_COLOR === undefined &&
    (process.stdout.isTTY || process.env.FORCE_COLOR !== undefined);
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
};
// ── Formatting helpers ────────────────────────────────────────
function formatDuration(ms) {
    if (ms <= 0)
        return 'now';
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}
function formatResetTime(resetsAt) {
    if (!resetsAt)
        return `${c.dim}—${c.reset}`;
    const remaining = resetsAt - Date.now();
    if (remaining <= 0)
        return `${c.dim}now${c.reset}`;
    return formatDuration(remaining);
}
function utilizationColor(pct) {
    if (pct >= 80)
        return c.red;
    if (pct >= 50)
        return c.yellow;
    return c.green;
}
function buildBar(pct, width = 8) {
    const filled = Math.round((pct / 100) * width);
    const empty = width - filled;
    const color = utilizationColor(pct);
    return `${color}${'█'.repeat(filled)}${c.dim}${'░'.repeat(empty)}${c.reset}`;
}
function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
}
function visibleLength(str) {
    return stripAnsi(str).length;
}
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
function truncateText(str, maxLen) {
    if (str.length <= maxLen)
        return str;
    if (maxLen <= 1)
        return '…';
    return `${str.slice(0, maxLen - 1)}…`;
}
function padRight(str, len) {
    const pad = Math.max(0, len - visibleLength(str));
    return str + ' '.repeat(pad);
}
function padLeft(str, len) {
    const pad = Math.max(0, len - visibleLength(str));
    return ' '.repeat(pad) + str;
}
const CHART_BAR_WIDTH = 8;
function normalizeWindowLabel(label) {
    return label.trim().toLowerCase();
}
function isStandardWindowLabel(label) {
    const normalized = normalizeWindowLabel(label);
    return normalized === '5h' || normalized === 'weekly';
}
function findUsageWindow(usage, label) {
    if (usage.type !== 'quotaBased')
        return undefined;
    return usage.windows.find((window) => normalizeWindowLabel(window.label) === label);
}
function formatChartCell(window, width) {
    if (!window) {
        return padRight(`${c.dim}—${c.reset}`, width);
    }
    const used = Math.round(window.utilization);
    const pctColor = utilizationColor(used);
    const pct = padLeft(`${pctColor}${used}%${c.reset}`, 4);
    return padRight(`${buildBar(window.utilization, CHART_BAR_WIDTH)} ${pct}`, width);
}
function abbreviateWindowLabel(label) {
    const normalized = normalizeWindowLabel(label);
    if (normalized === 'weekly')
        return 'wk';
    return truncateText(label, 14);
}
function formatUsageDetails(usage) {
    if (usage.type === 'payAsYouGo') {
        return `$${usage.used.toFixed(2)} / $${usage.total.toFixed(2)}`;
    }
    const windows = usage.windows.filter((w) => w.label !== 'balance' && !w.label.startsWith('$'));
    const extraWindows = windows.filter((w) => !isStandardWindowLabel(w.label));
    const standardWindows = windows.filter((w) => isStandardWindowLabel(w.label));
    const parts = (extraWindows.length > 0 ? extraWindows : standardWindows)
        .slice(0, 3)
        .map((window) => {
        const used = Math.round(window.utilization);
        const left = Math.max(0, 100 - used);
        const color = utilizationColor(used);
        return `${c.dim}${abbreviateWindowLabel(window.label)}${c.reset} ${color}${used}${c.reset}${c.dim}/${c.reset}${color}${left}${c.reset}`;
    });
    if (parts.length > 0) {
        return parts.join(` ${c.dim}·${c.reset} `);
    }
    const pctColor = utilizationColor(usage.utilization);
    return `${pctColor}${Math.round(usage.utilization)}%${c.reset}`;
}
function formatPlanValue(rawPlan) {
    if (!rawPlan)
        return undefined;
    const trimmed = rawPlan.trim();
    if (!trimmed)
        return undefined;
    const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const knownPlans = {
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
    };
    const known = knownPlans[normalized];
    if (known)
        return known;
    return trimmed
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}
function extractPlanFromUsage(usage) {
    if (!usage || usage.type !== 'quotaBased')
        return undefined;
    for (const window of usage.windows) {
        const match = window.label.match(/\(([^()]+)\)/);
        if (match?.[1])
            return formatPlanValue(match[1]);
    }
    return undefined;
}
function extractPlanFromProviderName(result) {
    if (result.providerId !== 'copilot')
        return undefined;
    const match = result.providerName.match(/\(([^()]+)\)\s*$/);
    return match?.[1] ? formatPlanValue(match[1]) : undefined;
}
function getProviderDisplayName(result) {
    if (result.providerId === 'copilot') {
        return result.providerName.replace(/\s*\([^()]+\)\s*$/, '');
    }
    return result.providerName;
}
function getRenderContext() {
    const store = loadStore();
    const codexPlansByAlias = new Map();
    for (const account of Object.values(store.accounts)) {
        const plan = formatPlanValue(account.planType);
        if (plan) {
            codexPlansByAlias.set(account.alias, plan);
        }
    }
    return {
        activeAlias: store.activeAlias,
        codexPlansByAlias,
    };
}
function hasAccountRows(result) {
    return Array.isArray(result.accounts) && result.accounts.length > 0;
}
function getDisplayLabel(result, rawLabel, context) {
    const label = rawLabel || getProviderDisplayName(result);
    if (result.providerId === 'codex' && rawLabel && rawLabel === context.activeAlias) {
        return `${rawLabel} ${c.cyan}(active)${c.reset}`;
    }
    return label;
}
function getPlanLabel(result, usage, rawLabel, context) {
    if (result.providerId === 'codex' && rawLabel) {
        return context.codexPlansByAlias.get(rawLabel);
    }
    return extractPlanFromUsage(usage) || extractPlanFromProviderName(result);
}
function formatPlanCell(plan, width) {
    if (!plan) {
        return padRight(`${c.dim}—${c.reset}`, width);
    }
    return padRight(`${c.cyan}${truncateText(plan, width)}${c.reset}`, width);
}
function getTableLayout(results, context) {
    const labels = results.flatMap((result) => [
        getProviderDisplayName(result),
        ...(result.accounts?.map((acc) => `  ${getDisplayLabel(result, acc.label, context)}`) ?? []),
    ]);
    const providerWidth = clamp(Math.max(18, ...labels.map((label) => label.length)), 18, 34);
    const planLengths = results.flatMap((result) => {
        const plans = [];
        if (!hasAccountRows(result)) {
            plans.push(getPlanLabel(result, result.usage, undefined, context));
        }
        for (const account of result.accounts ?? []) {
            plans.push(getPlanLabel(result, account.usage, account.label, context));
        }
        return plans.map((plan) => visibleLength(plan ?? '—'));
    });
    const planWidth = clamp(Math.max(14, ...planLengths), 14, 24);
    return {
        providerWidth,
        chartWidth: 13,
        planWidth,
    };
}
// ── Format a single result row ────────────────────────────────
function formatResultRow(result, layout, context, label) {
    const rawLabel = label || getProviderDisplayName(result);
    const name = padRight(getDisplayLabel(result, rawLabel, context), layout.providerWidth);
    if (result.status === 'not_configured') {
        return `  ${c.dim}${name}${padRight('not configured', 12)}${c.reset}`;
    }
    if (result.status === 'auth_expired') {
        return `  ${c.dim}${name}${c.reset}${c.red}${padRight('auth expired', layout.chartWidth * 2)}${c.reset}  ${formatPlanCell(undefined, layout.planWidth)}${c.dim}${result.error || ''}${c.reset}`;
    }
    if (result.status === 'error') {
        return `  ${name}${c.red}${padRight('error', layout.chartWidth * 2)}${c.reset}  ${formatPlanCell(undefined, layout.planWidth)}${c.dim}${(result.error || '').slice(0, 50)}${c.reset}`;
    }
    if (!result.usage) {
        return `  ${name}${c.dim}no data${c.reset}`;
    }
    const usage = result.usage;
    const fiveHourChart = formatChartCell(findUsageWindow(usage, '5h'), layout.chartWidth);
    const weeklyChart = formatChartCell(findUsageWindow(usage, 'weekly'), layout.chartWidth);
    const planCell = formatPlanCell(getPlanLabel(result, usage, label, context), layout.planWidth);
    if (usage.type === 'payAsYouGo') {
        return `  ${name}${padRight(`${c.dim}—${c.reset}`, layout.chartWidth)}${padRight(`${c.dim}—${c.reset}`, layout.chartWidth)}  ${planCell}${c.dim}—${c.reset}`;
    }
    // Reset time: pick earliest reset
    const resets = usage.windows
        .filter((w) => w.resetsAt && w.resetsAt > Date.now())
        .sort((a, b) => (a.resetsAt || 0) - (b.resetsAt || 0));
    const resetStr = resets.length > 0 ? formatResetTime(resets[0].resetsAt) : `${c.dim}—${c.reset}`;
    return `  ${name}${fiveHourChart}${weeklyChart}  ${planCell}${resetStr}`;
}
function formatProviderHeaderRow(result, layout) {
    const name = padRight(getProviderDisplayName(result), layout.providerWidth);
    return `  ${c.bold}${name}${c.reset}${' '.repeat(layout.chartWidth)}${' '.repeat(layout.chartWidth)}  ${' '.repeat(layout.planWidth)}`;
}
// ── Format account sub-rows ───────────────────────────────────
function formatAccountRows(result, layout, context) {
    if (!result.accounts || result.accounts.length === 0)
        return [];
    return result.accounts.map((acc) => {
        const subLabel = `  ${getDisplayLabel(result, acc.label, context)}`;
        const subResult = {
            providerId: result.providerId,
            providerName: subLabel,
            billingType: result.billingType,
            status: acc.status,
            usage: acc.usage,
            error: acc.error,
            fetchedAt: result.fetchedAt,
        };
        return formatResultRow(subResult, layout, context, subLabel);
    });
}
export async function runUsageCommand(opts) {
    const providerIds = opts.provider ? [opts.provider] : undefined;
    // Validate provider name
    if (opts.provider) {
        const valid = allProviders.map((p) => p.id);
        if (!valid.includes(opts.provider)) {
            console.error(`Unknown provider: ${opts.provider}\nAvailable: ${valid.join(', ')}`);
            process.exit(1);
        }
    }
    // Try cache first (unless --no-cache or --json)
    if (!opts.noCache && !opts.json) {
        const cached = readUsageCache();
        if (cached) {
            const filtered = providerIds
                ? cached.results.filter((r) => providerIds.includes(r.providerId))
                : cached.results;
            renderTable(filtered, opts.verbose);
            return;
        }
    }
    // Show spinner
    if (!opts.json) {
        process.stdout.write(`${c.dim}Fetching usage from ${providerIds ? providerIds.length : allProviders.length} providers...${c.reset}`);
    }
    const results = await fetchAllUsage({ providerIds });
    // Cache results
    writeUsageCache(results);
    // Clear spinner line
    if (!opts.json) {
        process.stdout.write('\r' + ' '.repeat(60) + '\r');
    }
    // JSON output
    if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
    }
    renderTable(results, opts.verbose);
}
function renderTable(results, verbose = false) {
    const context = getRenderContext();
    const layout = getTableLayout(results, context);
    // Table output
    const configured = results.filter((r) => r.status !== 'not_configured');
    const notConfigured = results.filter((r) => r.status === 'not_configured');
    console.log();
    const header = `  ${c.bold}${padRight('Provider', layout.providerWidth)}${padRight('5h', layout.chartWidth)}${padRight('Weekly', layout.chartWidth)}  ${padRight('Plan', layout.planWidth)}Resets${c.reset}`;
    const divider = `  ${c.dim}${'─'.repeat(visibleLength(header) - 2)}${c.reset}`;
    console.log(header);
    console.log(divider);
    for (const result of configured) {
        if (hasAccountRows(result)) {
            console.log(formatProviderHeaderRow(result, layout));
            const subRows = formatAccountRows(result, layout, context);
            for (const row of subRows) {
                console.log(row);
            }
            continue;
        }
        console.log(formatResultRow(result, layout, context));
    }
    if (notConfigured.length > 0) {
        console.log(divider);
        for (const result of notConfigured) {
            console.log(formatResultRow(result, layout, context));
        }
    }
    console.log(divider);
    // Summary
    const okCount = configured.filter((r) => r.status === 'ok').length;
    const errCount = configured.filter((r) => r.status === 'error' || r.status === 'auth_expired').length;
    const notConfCount = notConfigured.length;
    const parts = [];
    if (okCount > 0)
        parts.push(`${c.green}${okCount} ok${c.reset}`);
    if (errCount > 0)
        parts.push(`${c.red}${errCount} error${c.reset}`);
    if (notConfCount > 0)
        parts.push(`${c.dim}${notConfCount} not configured${c.reset}`);
    console.log(`  ${parts.join(`  ${c.dim}·${c.reset}  `)}`);
    console.log();
}
//# sourceMappingURL=usage-command.js.map