import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const SELF_GITHUB_OWNER = 'rokartur';
const SELF_GITHUB_REPO = 'opencode-enhancer';
const SELF_GITHUB_GIT_URL = `git+https://github.com/${SELF_GITHUB_OWNER}/${SELF_GITHUB_REPO}.git`;
const SELF_GITHUB_SEMVER_REF = 'semver:*';
const SELF_GITHUB_SEMVER_SPEC = `${SELF_GITHUB_GIT_URL}#${SELF_GITHUB_SEMVER_REF}`;
const GITHUB_TAGS_API_URL = `https://api.github.com/repos/${SELF_GITHUB_OWNER}/${SELF_GITHUB_REPO}/tags?per_page=100`;
function getOpenCodeConfigPath() {
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    return join(xdgConfig, 'opencode', 'opencode.json');
}
function loadConfiguredPlugins() {
    const configPath = getOpenCodeConfigPath();
    if (!existsSync(configPath)) {
        throw new Error(`OpenCode config not found: ${configPath}`);
    }
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.plugin)) {
        return [];
    }
    return parsed.plugin.filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
}
function parsePluginSpec(spec) {
    const trimmed = spec.trim();
    if (!trimmed) {
        return { raw: spec, kind: 'unknown' };
    }
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('file:') ||
        lower.startsWith('link:') ||
        lower.startsWith('workspace:') ||
        lower.startsWith('/') ||
        lower.startsWith('./') ||
        lower.startsWith('../')) {
        return { raw: spec, kind: 'local' };
    }
    if (lower.startsWith('git+') ||
        lower.startsWith('github:') ||
        lower.startsWith('http://') ||
        lower.startsWith('https://')) {
        const [remoteUrl, ref] = trimmed.split('#', 2);
        const githubMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/#]+?)(?:\.git)?$/i)
            || remoteUrl.match(/^github:([^/]+)\/([^/#]+)$/i);
        return {
            raw: spec,
            kind: 'remote',
            remoteUrl,
            ref: ref || undefined,
            githubOwner: githubMatch?.[1],
            githubRepo: githubMatch?.[2],
        };
    }
    if (trimmed.startsWith('@')) {
        const versionSeparator = trimmed.lastIndexOf('@');
        if (versionSeparator > 0) {
            return {
                raw: spec,
                kind: 'registry',
                moduleName: trimmed.slice(0, versionSeparator),
                versionSpec: trimmed.slice(versionSeparator + 1) || undefined,
            };
        }
    }
    const unscopedSeparator = trimmed.indexOf('@');
    if (unscopedSeparator > 0) {
        return {
            raw: spec,
            kind: 'registry',
            moduleName: trimmed.slice(0, unscopedSeparator),
            versionSpec: trimmed.slice(unscopedSeparator + 1) || undefined,
        };
    }
    return {
        raw: spec,
        kind: 'registry',
        moduleName: trimmed,
    };
}
function updatePlugin(moduleName) {
    execFileSync('opencode', ['plugin', `${moduleName}@latest`, '--global', '--force'], { stdio: 'inherit' });
}
function updatePluginSpec(pluginSpec) {
    execFileSync('opencode', ['plugin', pluginSpec, '--global', '--force'], { stdio: 'inherit' });
}
function parseStableSemverTag(tag) {
    const match = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    if (!match) {
        return null;
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function compareVersions(a, b) {
    if (a[0] !== b[0])
        return a[0] - b[0];
    if (a[1] !== b[1])
        return a[1] - b[1];
    return a[2] - b[2];
}
async function fetchLatestSelfTag() {
    const response = await fetch(GITHUB_TAGS_API_URL, {
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'opencode-enhancer',
        },
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch GitHub tags (${response.status})`);
    }
    const tags = await response.json();
    const stableTags = tags
        .map((entry) => typeof entry.name === 'string' ? entry.name.trim() : '')
        .filter(Boolean)
        .map((name) => ({ name, version: parseStableSemverTag(name) }))
        .filter((entry) => entry.version !== null)
        .sort((a, b) => compareVersions(b.version, a.version));
    if (stableTags.length === 0) {
        throw new Error(`No stable GitHub tags found for ${SELF_GITHUB_OWNER}/${SELF_GITHUB_REPO}`);
    }
    return stableTags[0].name;
}
function isSelfGithubPlugin(parsed) {
    return parsed.kind === 'remote'
        && parsed.githubOwner?.toLowerCase() === SELF_GITHUB_OWNER
        && parsed.githubRepo?.toLowerCase() === SELF_GITHUB_REPO;
}
function printSummary(results, dryRun) {
    const updated = results.filter((result) => result.action === 'updated');
    const skipped = results.filter((result) => result.action === 'skipped');
    console.log();
    console.log(dryRun ? '[plugins] Planned updates' : '[plugins] Update summary');
    for (const result of results) {
        if (result.action === 'updated') {
            console.log(`  updated ${result.plugin}`);
            continue;
        }
        console.log(`  skipped ${result.plugin}${result.reason ? ` (${result.reason})` : ''}`);
    }
    console.log();
    console.log(`  ${updated.length} ${dryRun ? 'planned' : 'updated'} · ${skipped.length} skipped`);
    console.log();
}
export async function runPluginsUpdateCommand(options) {
    const configuredPlugins = loadConfiguredPlugins();
    const exclude = new Set((options.exclude || []).map((item) => item.trim()).filter(Boolean));
    const results = [];
    let latestSelfTag;
    let selfTagError;
    for (const rawSpec of configuredPlugins) {
        const parsed = parsePluginSpec(rawSpec);
        if (isSelfGithubPlugin(parsed)) {
            const selfName = `${SELF_GITHUB_OWNER}/${SELF_GITHUB_REPO}`;
            if (exclude.has(SELF_GITHUB_REPO) || exclude.has(selfName)) {
                results.push({
                    plugin: rawSpec,
                    action: 'skipped',
                    reason: 'excluded',
                });
                continue;
            }
            if (!latestSelfTag && !selfTagError) {
                try {
                    latestSelfTag = await fetchLatestSelfTag();
                }
                catch (error) {
                    selfTagError = error instanceof Error ? error.message : String(error);
                }
            }
            if (!latestSelfTag) {
                results.push({
                    plugin: rawSpec,
                    action: 'skipped',
                    reason: selfTagError || 'failed to resolve latest GitHub tag',
                });
                continue;
            }
            const targetSpec = SELF_GITHUB_SEMVER_SPEC;
            if (options.dryRun) {
                results.push({
                    plugin: targetSpec,
                    action: 'updated',
                });
                continue;
            }
            updatePluginSpec(targetSpec);
            results.push({
                plugin: targetSpec,
                action: 'updated',
            });
            continue;
        }
        if (parsed.kind !== 'registry' || !parsed.moduleName) {
            results.push({
                plugin: rawSpec,
                action: 'skipped',
                reason: parsed.kind === 'local'
                    ? 'local plugin'
                    : parsed.kind === 'remote'
                        ? 'remote/git plugin'
                        : 'unsupported spec',
            });
            continue;
        }
        if (exclude.has(parsed.moduleName)) {
            results.push({
                plugin: rawSpec,
                action: 'skipped',
                reason: 'excluded',
            });
            continue;
        }
        if (!options.includePinned && parsed.versionSpec && parsed.versionSpec !== 'latest') {
            results.push({
                plugin: rawSpec,
                action: 'skipped',
                reason: `pinned version (${parsed.versionSpec})`,
            });
            continue;
        }
        if (options.dryRun) {
            results.push({
                plugin: `${parsed.moduleName}@latest`,
                action: 'updated',
            });
            continue;
        }
        updatePlugin(parsed.moduleName);
        results.push({
            plugin: `${parsed.moduleName}@latest`,
            action: 'updated',
        });
    }
    printSummary(results, options.dryRun === true);
}
//# sourceMappingURL=plugin-updates.js.map