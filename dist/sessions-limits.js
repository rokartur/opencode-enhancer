import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { hasMeaningfulRateLimits } from './rate-limits.js';
const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
function toEpochMs(value) {
    if (value === undefined)
        return undefined;
    if (value > 1e12)
        return value;
    if (value > 1e9)
        return value * 1000;
    return value * 1000;
}
function parseTimestamp(value) {
    if (!value)
        return undefined;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed))
        return undefined;
    return parsed;
}
function isWeekly(limit) {
    const minutes = limit?.window_minutes;
    if (!minutes)
        return false;
    return minutes >= 1000;
}
function buildWindow(limit, eventTs) {
    if (!limit)
        return undefined;
    const used = limit.used_percent;
    const remaining = typeof used === 'number' ? Math.max(0, 100 - used) : undefined;
    const resetAt = toEpochMs(limit.resets_at ?? limit.reset_at) ??
        (typeof limit.resets_in_seconds === 'number' && eventTs
            ? eventTs + limit.resets_in_seconds * 1000
            : undefined);
    return {
        limit: 100,
        remaining,
        resetAt,
        updatedAt: eventTs
    };
}
function listSessionFiles(dir) {
    const entries = [];
    if (!fs.existsSync(dir))
        return entries;
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current)
            continue;
        const items = fs.readdirSync(current, { withFileTypes: true });
        for (const item of items) {
            const fullPath = path.join(current, item.name);
            if (item.isDirectory()) {
                stack.push(fullPath);
            }
            else if (item.isFile() && item.name.endsWith('.jsonl')) {
                const stat = fs.statSync(fullPath);
                entries.push({ path: fullPath, mtimeMs: stat.mtimeMs });
            }
        }
    }
    return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function parseLatestTokenCountFromFile(filePath, options) {
    let contents = '';
    try {
        contents = fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        return null;
    }
    const lines = contents.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        let parsed = null;
        try {
            parsed = JSON.parse(lines[i]);
        }
        catch {
            continue;
        }
        const payload = parsed?.payload;
        if (payload?.type !== 'token_count')
            continue;
        const eventTs = parseTimestamp(parsed.timestamp);
        if (!eventTs)
            continue;
        if (options?.sinceMs && eventTs < options.sinceMs)
            continue;
        if (options?.untilMs && eventTs > options.untilMs)
            continue;
        const primary = payload.rate_limits?.primary;
        const secondary = payload.rate_limits?.secondary;
        const fiveHour = isWeekly(primary) ? secondary : primary;
        const weekly = isWeekly(primary) ? primary : secondary;
        const rateLimits = {
            fiveHour: buildWindow(fiveHour, eventTs),
            weekly: buildWindow(weekly, eventTs)
        };
        if (!hasMeaningfulRateLimits(rateLimits)) {
            continue;
        }
        return {
            eventTs,
            rateLimits
        };
    }
    return null;
}
export function findLatestSessionRateLimits(options) {
    const sessionsDir = options?.sessionsDir || DEFAULT_SESSIONS_DIR;
    const files = listSessionFiles(sessionsDir);
    for (const file of files) {
        const parsed = parseLatestTokenCountFromFile(file.path, options);
        if (parsed?.rateLimits) {
            return {
                rateLimits: parsed.rateLimits,
                eventTs: parsed.eventTs,
                sourceFile: file.path
            };
        }
    }
    return null;
}
//# sourceMappingURL=sessions-limits.js.map