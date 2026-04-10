// CLI usage command: formatted table output for provider usage
import { fetchAllUsage, allProviders } from './providers/index.js';
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
function padRight(str, len) {
    // Strip ANSI codes for length calculation
    const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
    const pad = Math.max(0, len - stripped.length);
    return str + ' '.repeat(pad);
}
function padLeft(str, len) {
    const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
    const pad = Math.max(0, len - stripped.length);
    return ' '.repeat(pad) + str;
}
// ── Format a single result row ────────────────────────────────
function formatResultRow(result, label) {
    const name = padRight(label || result.providerName, 18);
    if (result.status === 'not_configured') {
        return `  ${c.dim}${name}${padRight('not configured', 12)}${c.reset}`;
    }
    if (result.status === 'auth_expired') {
        return `  ${c.dim}${padRight(label || result.providerName, 18)}${c.reset}${c.red}${padRight('auth expired', 12)}${c.reset}  ${c.dim}${result.error || ''}${c.reset}`;
    }
    if (result.status === 'error') {
        return `  ${padRight(label || result.providerName, 18)}${c.red}${padRight('error', 12)}${c.reset}  ${c.dim}${(result.error || '').slice(0, 50)}${c.reset}`;
    }
    if (!result.usage) {
        return `  ${padRight(label || result.providerName, 18)}${c.dim}no data${c.reset}`;
    }
    const usage = result.usage;
    if (usage.type === 'payAsYouGo') {
        const bar = buildBar(usage.utilization);
        const costStr = `$${usage.used.toFixed(2)} / $${usage.total.toFixed(2)}`;
        return `  ${padRight(label || result.providerName, 18)}${bar}  ${padRight(costStr, 22)}${c.dim}—${c.reset}`;
    }
    // quotaBased
    const bar = buildBar(usage.utilization);
    const pctColor = utilizationColor(usage.utilization);
    // Build usage string from windows
    let usageStr = '';
    if (usage.windows.length > 0) {
        const parts = usage.windows
            .filter(w => w.label !== 'balance' && !w.label.startsWith('$'))
            .slice(0, 3) // Show up to 3 windows
            .map((w) => {
            const wColor = utilizationColor(w.utilization);
            return `${wColor}${Math.round(w.utilization)}%${c.reset} ${c.dim}(${w.label})${c.reset}`;
        });
        usageStr = parts.join('  ');
    }
    else {
        usageStr = `${pctColor}${Math.round(usage.utilization)}%${c.reset}`;
    }
    // Reset time: pick earliest reset
    const resets = usage.windows
        .filter((w) => w.resetsAt && w.resetsAt > Date.now())
        .sort((a, b) => (a.resetsAt || 0) - (b.resetsAt || 0));
    const resetStr = resets.length > 0 ? formatResetTime(resets[0].resetsAt) : `${c.dim}—${c.reset}`;
    return `  ${padRight(label || result.providerName, 18)}${bar}  ${padRight(usageStr, 32)}${resetStr}`;
}
// ── Format account sub-rows ───────────────────────────────────
function formatAccountRows(result) {
    if (!result.accounts || result.accounts.length <= 1)
        return [];
    return result.accounts.map((acc) => {
        const subLabel = `  ${acc.label}`;
        const subResult = {
            providerId: result.providerId,
            providerName: subLabel,
            billingType: result.billingType,
            status: acc.status,
            usage: acc.usage,
            error: acc.error,
            fetchedAt: result.fetchedAt,
        };
        return formatResultRow(subResult, subLabel);
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
    // Table output
    const configured = results.filter((r) => r.status !== 'not_configured');
    const notConfigured = results.filter((r) => r.status === 'not_configured');
    console.log();
    console.log(`  ${c.bold}${padRight('Provider', 18)}${padRight('Usage', 10)}  ${padRight('Details', 32)}Resets${c.reset}`);
    console.log(`  ${c.dim}${'─'.repeat(78)}${c.reset}`);
    for (const result of configured) {
        console.log(formatResultRow(result));
        // Show sub-accounts for multi-account providers
        if (verbose || (result.accounts && result.accounts.length > 1)) {
            const subRows = formatAccountRows(result);
            for (const row of subRows) {
                console.log(row);
            }
        }
    }
    if (notConfigured.length > 0) {
        console.log(`  ${c.dim}${'─'.repeat(78)}${c.reset}`);
        for (const result of notConfigured) {
            console.log(formatResultRow(result));
        }
    }
    console.log(`  ${c.dim}${'─'.repeat(78)}${c.reset}`);
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