// CLI usage command: formatted table output for provider usage
import { fetchAllUsage, allProviders } from "./providers/index.js";
import { decodeJwtPayload } from "./jwt.js";
import { loadStore } from "./store.js";
import { readUsageCache, writeUsageCache } from "./usage-cache.js";
// ── ANSI helpers ──────────────────────────────────────────────
const isColorSupported = process.env.FORCE_COLOR !== "0" &&
    process.env.NO_COLOR === undefined &&
    (process.stdout.isTTY || process.env.FORCE_COLOR !== undefined);
const c = {
    reset: isColorSupported ? "\x1b[0m" : "",
    bold: isColorSupported ? "\x1b[1m" : "",
    dim: isColorSupported ? "\x1b[2m" : "",
    red: isColorSupported ? "\x1b[31m" : "",
    green: isColorSupported ? "\x1b[32m" : "",
    yellow: isColorSupported ? "\x1b[33m" : "",
    blue: isColorSupported ? "\x1b[34m" : "",
    cyan: isColorSupported ? "\x1b[36m" : "",
    gray: isColorSupported ? "\x1b[90m" : "",
    white: isColorSupported ? "\x1b[37m" : "",
};
// ── Formatting helpers ────────────────────────────────────────
function formatDuration(ms) {
    if (ms <= 0)
        return "now";
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
    return `${color}${"█".repeat(filled)}${c.dim}${"░".repeat(empty)}${c.reset}`;
}
function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, "");
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
        return "…";
    return `${str.slice(0, maxLen - 1)}…`;
}
function padRight(str, len) {
    const pad = Math.max(0, len - visibleLength(str));
    return str + " ".repeat(pad);
}
function padLeft(str, len) {
    const pad = Math.max(0, len - visibleLength(str));
    return " ".repeat(pad) + str;
}
const TABLE_INDENT = "  ";
const COLUMN_GAP = "  ";
const MINI_BAR_WIDTH = 4;
function normalizeWindowLabel(label) {
    return label.trim().toLowerCase();
}
function abbreviateWindowLabel(label) {
    const normalized = normalizeWindowLabel(label);
    if (normalized === "weekly")
        return "wk";
    if (normalized === "monthly")
        return "mo";
    return truncateText(label, 14);
}
function formatCount(value) {
    if (!Number.isFinite(value))
        return "0";
    if (Math.abs(value) >= 1000) {
        return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
    }
    if (Number.isInteger(value))
        return String(value);
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}
function getUsageWindows(usage) {
    if (usage.type !== "quotaBased")
        return [];
    return usage.windows.filter((window) => window.label !== "balance" && !window.label.startsWith("$"));
}
function formatMiniChart(utilization) {
    return buildBar(utilization, MINI_BAR_WIDTH);
}
function getUsageTotals(usage) {
    if (usage.type === "payAsYouGo") {
        return {
            usedLabel: `$${usage.used.toFixed(2)}`,
            totalLabel: `$${usage.total.toFixed(2)}`,
            remainingLabel: `$${usage.remaining.toFixed(2)}`,
        };
    }
    if (typeof usage.entitlement === "number" &&
        typeof usage.remaining === "number" &&
        usage.entitlement > 0) {
        const remaining = Math.max(0, usage.remaining);
        const used = usage.remaining < 0
            ? usage.entitlement + Math.abs(usage.remaining)
            : usage.entitlement - remaining;
        return {
            usedLabel: formatCount(used),
            totalLabel: formatCount(usage.entitlement),
            remainingLabel: formatCount(remaining),
        };
    }
    const usedPct = Math.round(usage.utilization);
    const remainingPct = Math.max(0, 100 - usedPct);
    return {
        usedLabel: `${usedPct}%`,
        totalLabel: "100%",
        remainingLabel: `${remainingPct}%`,
    };
}
function hasAbsoluteQuotaTotals(usage) {
    return (usage.type === "quotaBased" &&
        typeof usage.entitlement === "number" &&
        typeof usage.remaining === "number" &&
        usage.entitlement > 0);
}
function formatUsageSummary(usage) {
    const totals = getUsageTotals(usage);
    const pctColor = utilizationColor(usage.utilization);
    const parts = [
        `${formatMiniChart(usage.utilization)} ${pctColor}${Math.round(usage.utilization)}%${c.reset}`,
        `${c.red}${totals.usedLabel}${c.reset} ${c.dim}used${c.reset}`,
        `${c.cyan}${totals.totalLabel}${c.reset} ${c.dim}total${c.reset}`,
        `${c.green}${totals.remainingLabel}${c.reset} ${c.dim}left${c.reset}`,
    ];
    return parts.join(` ${c.dim}·${c.reset} `);
}
function formatQuotaWindowDetails(window, usage, index) {
    const used = Math.round(window.utilization);
    const left = Math.max(0, 100 - used);
    const totals = index === 0 && hasAbsoluteQuotaTotals(usage) ? getUsageTotals(usage) : undefined;
    const parts = [
        `${c.bold}${window.label}${c.reset}`,
        `${formatMiniChart(window.utilization)} ${utilizationColor(window.utilization)}${used}%${c.reset} ${c.dim}used${c.reset}`,
    ];
    if (totals) {
        parts.push(`${c.red}${totals.usedLabel}${c.reset} ${c.dim}used${c.reset}`, `${c.cyan}${totals.totalLabel}${c.reset} ${c.dim}total${c.reset}`, `${c.green}${totals.remainingLabel}${c.reset} ${c.dim}left${c.reset}`);
    }
    else {
        parts.push(`${utilizationColor(window.utilization)}${left}%${c.reset} ${c.dim}left${c.reset}`);
    }
    parts.push(`${c.dim}resets ${formatResetTime(window.resetsAt)}${c.reset}`);
    return parts.join(` ${c.dim}·${c.reset} `);
}
function formatUsageDetailLines(usage) {
    if (usage.type === "payAsYouGo") {
        return [
            `${c.dim}credits${c.reset} ${c.red}$${usage.used.toFixed(2)}${c.reset} ${c.dim}used${c.reset} ${c.dim}·${c.reset} ${c.cyan}$${usage.total.toFixed(2)}${c.reset} ${c.dim}total${c.reset} ${c.dim}·${c.reset} ${c.green}$${usage.remaining.toFixed(2)}${c.reset} ${c.dim}left${c.reset}`,
        ];
    }
    return getUsageWindows(usage).map((window, index) => formatQuotaWindowDetails(window, usage, index));
}
function getStatusLabel(status) {
    if (status === "auth_expired")
        return "auth expired";
    if (status === "not_configured")
        return "not configured";
    return status;
}
function formatStatusCell(status, width) {
    const label = getStatusLabel(status);
    const color = status === "ok"
        ? c.green
        : status === "not_configured"
            ? c.dim
            : status === "auth_expired"
                ? c.yellow
                : c.red;
    return padRight(`${color}${label}${c.reset}`, width);
}
function formatMetricCell(value, width, color) {
    return padLeft(`${color}${value}${c.reset}`, width);
}
function getPrimaryResetLabel(usage) {
    if (!usage || usage.type !== "quotaBased")
        return "—";
    const resets = usage.windows
        .filter((window) => window.resetsAt && window.resetsAt > Date.now())
        .sort((a, b) => (a.resetsAt || 0) - (b.resetsAt || 0));
    return resets.length > 0 ? stripAnsi(formatResetTime(resets[0].resetsAt)) : "—";
}
function getWindowTotals(window) {
    if (typeof window.entitlement !== "number" ||
        typeof window.remaining !== "number" ||
        window.entitlement <= 0) {
        return undefined;
    }
    const remaining = Math.max(0, window.remaining);
    const used = window.remaining < 0
        ? window.entitlement + Math.abs(window.remaining)
        : window.entitlement - remaining;
    return {
        usedLabel: formatCount(used),
        totalLabel: formatCount(window.entitlement),
        remainingLabel: formatCount(remaining),
    };
}
function formatWindowDetail(window) {
    const pctUsed = Math.round(window.utilization);
    const pctLeft = Math.max(0, 100 - pctUsed);
    const totals = getWindowTotals(window);
    const parts = totals
        ? [
            `${c.red}${totals.usedLabel}${c.reset} ${c.dim}used${c.reset}`,
            `${c.cyan}${totals.totalLabel}${c.reset} ${c.dim}total${c.reset}`,
            `${c.green}${totals.remainingLabel}${c.reset} ${c.dim}left${c.reset}`,
            `${utilizationColor(window.utilization)}${pctUsed}%${c.reset}`,
        ]
        : [
            `${utilizationColor(window.utilization)}${pctUsed}%${c.reset} ${c.dim}used${c.reset}`,
            `${c.green}${pctLeft}%${c.reset} ${c.dim}left${c.reset}`,
        ];
    parts.push(`${c.dim}resets ${stripAnsi(formatResetTime(window.resetsAt))}${c.reset}`);
    return `${c.bold}${window.label}${c.reset}: ${parts.join(` ${c.dim}·${c.reset} `)}`;
}
function getResultDetailLines(result, verbose) {
    if (result.status === "error" || result.status === "auth_expired") {
        return result.error ? [result.error] : [];
    }
    if (result.status !== "ok" || !result.usage)
        return [];
    if (result.usage.type === "payAsYouGo") {
        return verbose ? formatUsageDetailLines(result.usage) : [];
    }
    const windows = getUsageWindows(result.usage);
    if (windows.length === 0)
        return [];
    if (!verbose && windows.length === 1)
        return [];
    return windows.map((window) => formatWindowDetail(window));
}
function buildSummaryRow(result, context, verbose, labels) {
    const rawLabel = labels?.rawLabel;
    const provider = labels?.displayLabel || getDisplayLabel(result, rawLabel, context);
    const plan = getPlanLabel(result, result.usage, rawLabel, context, result.plan) || "—";
    if (result.status !== "ok" || !result.usage) {
        return {
            provider,
            status: result.status,
            plan,
            used: "—",
            total: "—",
            left: "—",
            reset: "—",
            details: getResultDetailLines(result, verbose),
        };
    }
    const totals = getUsageTotals(result.usage);
    return {
        provider,
        status: result.status,
        plan,
        used: totals.usedLabel,
        total: totals.totalLabel,
        left: totals.remainingLabel,
        reset: getPrimaryResetLabel(result.usage),
        usage: result.usage,
        details: getResultDetailLines(result, verbose),
    };
}
function getSummaryTableLayout(rows) {
    return {
        providerWidth: Math.max(18, ...rows.map((row) => visibleLength(row.provider)), visibleLength("Provider / Account")),
        statusWidth: Math.max(14, ...rows.map((row) => visibleLength(getStatusLabel(row.status))), visibleLength("Status")),
        planWidth: Math.max(10, ...rows.map((row) => visibleLength(row.plan)), visibleLength("Plan")),
        usedWidth: Math.max(8, ...rows.map((row) => visibleLength(row.used)), visibleLength("Used")),
        totalWidth: Math.max(8, ...rows.map((row) => visibleLength(row.total)), visibleLength("Total")),
        leftWidth: Math.max(8, ...rows.map((row) => visibleLength(row.left)), visibleLength("Left")),
        resetWidth: Math.max(8, ...rows.map((row) => visibleLength(row.reset)), visibleLength("Reset")),
    };
}
function formatSummaryRow(row, layout) {
    const providerCell = padRight(row.provider, layout.providerWidth);
    const planCell = padRight(row.plan === "—" ? `${c.dim}—${c.reset}` : `${c.cyan}${row.plan}${c.reset}`, layout.planWidth);
    const usedCell = row.status === "ok"
        ? formatMetricCell(row.used, layout.usedWidth, c.red)
        : padLeft(`${c.dim}${row.used}${c.reset}`, layout.usedWidth);
    const totalCell = row.status === "ok"
        ? formatMetricCell(row.total, layout.totalWidth, c.cyan)
        : padLeft(`${c.dim}${row.total}${c.reset}`, layout.totalWidth);
    const leftCell = row.status === "ok"
        ? formatMetricCell(row.left, layout.leftWidth, c.green)
        : padLeft(`${c.dim}${row.left}${c.reset}`, layout.leftWidth);
    const resetCell = padLeft(row.reset === "—" ? `${c.dim}—${c.reset}` : row.reset, layout.resetWidth);
    return `${TABLE_INDENT}${providerCell}${COLUMN_GAP}${formatStatusCell(row.status, layout.statusWidth)}${COLUMN_GAP}${planCell}${COLUMN_GAP}${usedCell}${COLUMN_GAP}${totalCell}${COLUMN_GAP}${leftCell}${COLUMN_GAP}${resetCell}`;
}
function formatDetailLine(detail) {
    return `${TABLE_INDENT}  ${c.dim}↳${c.reset} ${detail}`;
}
function formatQuotaWindow(window, usage) {
    const used = Math.round(window.utilization);
    const left = Math.max(0, 100 - used);
    const color = utilizationColor(used);
    const label = `${c.dim}${abbreviateWindowLabel(window.label)}${c.reset}`;
    const chart = formatMiniChart(window.utilization);
    if (usage.type === "quotaBased" &&
        typeof usage.remaining === "number" &&
        typeof usage.entitlement === "number" &&
        usage.entitlement > 0 &&
        getUsageWindows(usage)[0] === window) {
        return `${label} ${chart} ${c.green}${formatCount(usage.remaining)}${c.reset}${c.dim}/${c.reset}${c.cyan}${formatCount(usage.entitlement)}${c.reset}`;
    }
    return `${label} ${chart} ${color}${used}${c.reset}${c.dim}/${c.reset}${color}${left}${c.reset}`;
}
function formatUsageDetails(usage) {
    return formatUsageSummary(usage);
}
function formatPlanValue(rawPlan) {
    if (!rawPlan)
        return undefined;
    const trimmed = rawPlan.trim();
    if (!trimmed)
        return undefined;
    const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const knownPlans = {
        plus: "Plus",
        pro: "Pro",
        team: "Team",
        business: "Business",
        enterprise: "Enterprise",
        free: "Free",
        individual_pro: "Individual Pro",
        individual_free: "Individual Free",
        chatgpt_plus: "Plus",
        chatgptplus: "Plus",
        chatgpt_pro: "Pro",
        chatgptpro: "Pro",
        chatgpt_team: "Team",
        chatgptteam: "Team",
    };
    const known = knownPlans[normalized];
    if (known)
        return known;
    return trimmed
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}
function extractPlanFromUsage(usage) {
    if (!usage || usage.type !== "quotaBased")
        return undefined;
    for (const window of usage.windows) {
        const match = window.label.match(/\(([^()]+)\)/);
        if (match?.[1])
            return formatPlanValue(match[1]);
    }
    return undefined;
}
function extractPlanFromProviderName(result) {
    if (result.providerId !== "copilot")
        return undefined;
    const match = result.providerName.match(/\(([^()]+)\)\s*$/);
    return match?.[1] ? formatPlanValue(match[1]) : undefined;
}
function getProviderDisplayName(result) {
    if (result.providerId === "copilot") {
        return result.providerName.replace(/\s*\([^()]+\)\s*$/, "");
    }
    return result.providerName;
}
function getPlanTypeFromClaims(claims) {
    if (!claims)
        return undefined;
    const auth = claims["https://api.openai.com/auth"];
    return typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
}
function getCodexPlanFromAccount(account) {
    const explicitPlan = formatPlanValue(account.planType);
    if (explicitPlan)
        return explicitPlan;
    const accessTokenPlan = formatPlanValue(getPlanTypeFromClaims(decodeJwtPayload(account.accessToken)));
    if (accessTokenPlan)
        return accessTokenPlan;
    const idTokenPlan = formatPlanValue(getPlanTypeFromClaims(decodeJwtPayload(account.idToken || "")));
    if (idTokenPlan)
        return idTokenPlan;
    return undefined;
}
function getRenderContext() {
    const store = loadStore();
    const codexPlansByAlias = new Map();
    for (const account of Object.values(store.accounts)) {
        const plan = getCodexPlanFromAccount(account);
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
    if (result.providerId === "codex" && rawLabel && rawLabel === context.activeAlias) {
        return `${rawLabel} ${c.cyan}(active)${c.reset}`;
    }
    return label;
}
function normalizePlanLookupLabel(label) {
    if (!label)
        return undefined;
    const plain = stripAnsi(label)
        .replace(/\s+\(active\)\s*$/, "")
        .trim();
    return plain || undefined;
}
function getPlanLabel(result, usage, rawLabel, context, explicitPlan) {
    const directPlan = formatPlanValue(explicitPlan || result.plan);
    if (directPlan)
        return directPlan;
    if (result.providerId === "codex") {
        const lookupLabel = normalizePlanLookupLabel(rawLabel);
        if (lookupLabel) {
            return context.codexPlansByAlias.get(lookupLabel);
        }
    }
    return extractPlanFromUsage(usage) || extractPlanFromProviderName(result);
}
function formatPlanCell(plan, width) {
    if (!plan) {
        return padRight(`${c.dim}—${c.reset}`, width);
    }
    return padRight(`${c.cyan}${plan}${c.reset}`, width);
}
function getTableLayout(results, context) {
    const labels = results.flatMap((result) => [
        getProviderDisplayName(result),
        ...(result.accounts?.map((acc) => `  ${getDisplayLabel(result, acc.label, context)}`) ?? []),
    ]);
    const providerWidth = clamp(Math.max(18, ...labels.map((label) => visibleLength(label))), 18, Number.MAX_SAFE_INTEGER);
    const planLengths = results.flatMap((result) => {
        const plans = [];
        if (!hasAccountRows(result)) {
            plans.push(getPlanLabel(result, result.usage, undefined, context, result.plan));
        }
        for (const account of result.accounts ?? []) {
            plans.push(getPlanLabel(result, account.usage, account.label, context, account.plan));
        }
        return plans.map((plan) => visibleLength(plan ?? "—"));
    });
    const planWidth = clamp(Math.max(10, ...planLengths), 10, Number.MAX_SAFE_INTEGER);
    return {
        providerWidth,
        usageWidth: clamp(Math.max(18, ...results.flatMap((result) => {
            const values = [];
            if (result.usage)
                values.push(formatUsageDetails(result.usage));
            for (const account of result.accounts ?? []) {
                values.push(formatUsageDetails(account.usage));
            }
            return values.map((value) => visibleLength(value));
        })), 18, Number.MAX_SAFE_INTEGER),
        planWidth,
    };
}
// ── Format a single result row ────────────────────────────────
function formatResultRow(result, layout, context, labels) {
    const rawLabel = labels?.rawLabel;
    const displayLabel = labels?.displayLabel || getDisplayLabel(result, rawLabel, context);
    const name = padRight(displayLabel, layout.providerWidth);
    const tablePrefix = `${TABLE_INDENT}${name}${COLUMN_GAP}`;
    if (result.status === "not_configured") {
        return `${TABLE_INDENT}${c.dim}${name}${COLUMN_GAP}${padRight("not configured", layout.usageWidth + layout.planWidth + COLUMN_GAP.length + 6)}${c.reset}`;
    }
    if (result.status === "auth_expired") {
        return `${tablePrefix}${c.red}${padRight("auth expired", layout.usageWidth)}${c.reset}${COLUMN_GAP}${formatPlanCell(undefined, layout.planWidth)}${COLUMN_GAP}${c.dim}${result.error || ""}${c.reset}`;
    }
    if (result.status === "error") {
        return `${tablePrefix}${c.red}${padRight("error", layout.usageWidth)}${c.reset}${COLUMN_GAP}${formatPlanCell(undefined, layout.planWidth)}${COLUMN_GAP}${c.dim}${result.error || ""}${c.reset}`;
    }
    if (!result.usage) {
        return `${tablePrefix}${c.dim}no data${c.reset}`;
    }
    const usage = result.usage;
    const usageCell = padRight(formatUsageDetails(usage), layout.usageWidth);
    const planCell = formatPlanCell(getPlanLabel(result, usage, rawLabel, context, result.plan), layout.planWidth);
    if (usage.type === "payAsYouGo") {
        return `${tablePrefix}${usageCell}${COLUMN_GAP}${planCell}${COLUMN_GAP}${c.dim}—${c.reset}`;
    }
    // Reset time: pick earliest reset
    const resets = usage.windows
        .filter((w) => w.resetsAt && w.resetsAt > Date.now())
        .sort((a, b) => (a.resetsAt || 0) - (b.resetsAt || 0));
    const resetStr = resets.length > 0 ? formatResetTime(resets[0].resetsAt) : `${c.dim}—${c.reset}`;
    return `${tablePrefix}${usageCell}${COLUMN_GAP}${planCell}${COLUMN_GAP}${resetStr}`;
}
function formatProviderHeaderRow(result, layout) {
    const name = padRight(getProviderDisplayName(result), layout.providerWidth);
    return `${TABLE_INDENT}${c.bold}${name}${c.reset}${COLUMN_GAP}${" ".repeat(layout.usageWidth)}${COLUMN_GAP}${" ".repeat(layout.planWidth)}`;
}
function formatDetailRow(layout, detail) {
    const emptyProvider = " ".repeat(layout.providerWidth);
    const emptyPlan = " ".repeat(layout.planWidth);
    return `${TABLE_INDENT}${emptyProvider}${COLUMN_GAP}${c.dim}↳${c.reset} ${detail}${COLUMN_GAP}${emptyPlan}`;
}
function formatResultDetailRows(result, layout) {
    if (result.status !== "ok" || !result.usage)
        return [];
    return formatUsageDetailLines(result.usage).map((detail) => formatDetailRow(layout, detail));
}
// ── Format account sub-rows ───────────────────────────────────
function formatAccountRows(result, layout, context) {
    if (!result.accounts || result.accounts.length === 0)
        return [];
    return result.accounts.map((acc) => {
        const subLabel = `${TABLE_INDENT}${getDisplayLabel(result, acc.label, context)}`;
        const subResult = {
            providerId: result.providerId,
            providerName: acc.label,
            billingType: result.billingType,
            plan: acc.plan,
            status: acc.status,
            usage: acc.usage,
            error: acc.error,
            fetchedAt: result.fetchedAt,
        };
        return formatResultRow(subResult, layout, context, {
            rawLabel: acc.label,
            displayLabel: subLabel,
        });
    });
}
function isFullUsageCache(results) {
    const expectedProviderIds = new Set(allProviders.map((provider) => provider.id));
    if (results.length !== expectedProviderIds.size)
        return false;
    for (const result of results) {
        if (!expectedProviderIds.has(result.providerId)) {
            return false;
        }
    }
    return true;
}
export async function runUsageCommand(opts) {
    const providerIds = opts.provider ? [opts.provider] : undefined;
    // Validate provider name
    if (opts.provider) {
        const valid = allProviders.map((p) => p.id);
        if (!valid.includes(opts.provider)) {
            console.error(`Unknown provider: ${opts.provider}\nAvailable: ${valid.join(", ")}`);
            process.exit(1);
        }
    }
    // Try cache first (unless --no-cache or --json)
    if (!opts.noCache && !opts.json) {
        const cached = readUsageCache();
        if (cached) {
            if (!providerIds && !isFullUsageCache(cached.results)) {
                // Ignore stale partial caches left by older provider-scoped fetches.
            }
            else {
                const filtered = providerIds
                    ? cached.results.filter((r) => providerIds.includes(r.providerId))
                    : cached.results;
                if (providerIds ? filtered.length > 0 : true) {
                    renderTable(filtered, opts.verbose);
                    return;
                }
            }
        }
    }
    // Show spinner
    if (!opts.json) {
        process.stdout.write(`${c.dim}Fetching usage from ${providerIds ? providerIds.length : allProviders.length} providers...${c.reset}`);
    }
    const results = await fetchAllUsage({ providerIds });
    // Cache results
    if (!providerIds) {
        writeUsageCache(results);
    }
    // Clear spinner line
    if (!opts.json) {
        process.stdout.write("\r" + " ".repeat(60) + "\r");
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
    const configured = results.filter((r) => r.status !== "not_configured");
    const notConfigured = results.filter((r) => r.status === "not_configured");
    const summaryRows = [];
    for (const result of results) {
        if (hasAccountRows(result)) {
            for (const account of result.accounts ?? []) {
                const subResult = {
                    providerId: result.providerId,
                    providerName: account.label,
                    billingType: result.billingType,
                    plan: account.plan,
                    status: account.status,
                    usage: account.usage,
                    error: account.error,
                    fetchedAt: result.fetchedAt,
                };
                summaryRows.push(buildSummaryRow(subResult, context, verbose, {
                    rawLabel: account.label,
                    displayLabel: `  ${getDisplayLabel(result, account.label, context)}`,
                }));
            }
            continue;
        }
        summaryRows.push(buildSummaryRow(result, context, verbose));
    }
    const layout = getSummaryTableLayout(summaryRows);
    console.log();
    const header = `${TABLE_INDENT}${c.bold}${padRight("Provider / Account", layout.providerWidth)}${COLUMN_GAP}${padRight("Status", layout.statusWidth)}${COLUMN_GAP}${padRight("Plan", layout.planWidth)}${COLUMN_GAP}${padLeft("Used", layout.usedWidth)}${COLUMN_GAP}${padLeft("Total", layout.totalWidth)}${COLUMN_GAP}${padLeft("Left", layout.leftWidth)}${COLUMN_GAP}${padLeft("Reset", layout.resetWidth)}${c.reset}`;
    const divider = `${TABLE_INDENT}${c.dim}${"─".repeat(visibleLength(header) - visibleLength(TABLE_INDENT))}${c.reset}`;
    console.log(header);
    console.log(divider);
    for (const [resultIndex, result] of configured.entries()) {
        if (hasAccountRows(result)) {
            console.log(`${TABLE_INDENT}${c.bold}${getProviderDisplayName(result)}${c.reset}`);
            for (const account of result.accounts ?? []) {
                const subResult = {
                    providerId: result.providerId,
                    providerName: account.label,
                    billingType: result.billingType,
                    plan: account.plan,
                    status: account.status,
                    usage: account.usage,
                    error: account.error,
                    fetchedAt: result.fetchedAt,
                };
                const row = buildSummaryRow(subResult, context, verbose, {
                    rawLabel: account.label,
                    displayLabel: `  ${getDisplayLabel(result, account.label, context)}`,
                });
                console.log(formatSummaryRow(row, layout));
                for (const detail of row.details) {
                    console.log(formatDetailLine(detail));
                }
            }
            if (resultIndex < configured.length - 1) {
                console.log();
            }
            continue;
        }
        const row = buildSummaryRow(result, context, verbose);
        console.log(formatSummaryRow(row, layout));
        for (const detail of row.details) {
            console.log(formatDetailLine(detail));
        }
        if (resultIndex < configured.length - 1) {
            console.log();
        }
    }
    if (notConfigured.length > 0) {
        if (configured.length > 0) {
            console.log(divider);
        }
        for (const result of notConfigured) {
            const row = buildSummaryRow(result, context, verbose);
            console.log(formatSummaryRow(row, layout));
        }
    }
    console.log(divider);
    const okCount = configured.filter((r) => r.status === "ok").length;
    const errCount = configured.filter((r) => r.status === "error" || r.status === "auth_expired").length;
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