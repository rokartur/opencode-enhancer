import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type PluginSourceKind = 'registry' | 'local' | 'remote' | 'unknown'

interface ParsedPluginSpec {
  raw: string
  moduleName?: string
  versionSpec?: string
  kind: PluginSourceKind
}

export interface PluginUpdateOptions {
  dryRun?: boolean
  includePinned?: boolean
  exclude?: string[]
}

interface PluginUpdateResult {
  plugin: string
  action: 'updated' | 'skipped'
  reason?: string
}

function getOpenCodeConfigPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(xdgConfig, 'opencode', 'opencode.json')
}

function loadConfiguredPlugins(): string[] {
  const configPath = getOpenCodeConfigPath()
  if (!existsSync(configPath)) {
    throw new Error(`OpenCode config not found: ${configPath}`)
  }

  const raw = readFileSync(configPath, 'utf-8')
  const parsed = JSON.parse(raw) as { plugin?: unknown }
  if (!Array.isArray(parsed.plugin)) {
    return []
  }

  return parsed.plugin.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function parsePluginSpec(spec: string): ParsedPluginSpec {
  const trimmed = spec.trim()
  if (!trimmed) {
    return { raw: spec, kind: 'unknown' }
  }

  const lower = trimmed.toLowerCase()
  if (
    lower.startsWith('file:') ||
    lower.startsWith('link:') ||
    lower.startsWith('workspace:') ||
    lower.startsWith('/') ||
    lower.startsWith('./') ||
    lower.startsWith('../')
  ) {
    return { raw: spec, kind: 'local' }
  }

  if (
    lower.startsWith('git+') ||
    lower.startsWith('github:') ||
    lower.startsWith('http://') ||
    lower.startsWith('https://')
  ) {
    return { raw: spec, kind: 'remote' }
  }

  if (trimmed.startsWith('@')) {
    const versionSeparator = trimmed.lastIndexOf('@')
    if (versionSeparator > 0) {
      return {
        raw: spec,
        kind: 'registry',
        moduleName: trimmed.slice(0, versionSeparator),
        versionSpec: trimmed.slice(versionSeparator + 1) || undefined,
      }
    }
  }

  const unscopedSeparator = trimmed.indexOf('@')
  if (unscopedSeparator > 0) {
    return {
      raw: spec,
      kind: 'registry',
      moduleName: trimmed.slice(0, unscopedSeparator),
      versionSpec: trimmed.slice(unscopedSeparator + 1) || undefined,
    }
  }

  return {
    raw: spec,
    kind: 'registry',
    moduleName: trimmed,
  }
}

function updatePlugin(moduleName: string): void {
  execFileSync(
    'opencode',
    ['plugin', `${moduleName}@latest`, '--global', '--force'],
    { stdio: 'inherit' }
  )
}

function printSummary(results: PluginUpdateResult[], dryRun: boolean): void {
  const updated = results.filter((result) => result.action === 'updated')
  const skipped = results.filter((result) => result.action === 'skipped')

  console.log()
  console.log(dryRun ? '[plugins] Planned updates' : '[plugins] Update summary')

  for (const result of results) {
    if (result.action === 'updated') {
      console.log(`  updated ${result.plugin}`)
      continue
    }
    console.log(`  skipped ${result.plugin}${result.reason ? ` (${result.reason})` : ''}`)
  }

  console.log()
  console.log(`  ${updated.length} ${dryRun ? 'planned' : 'updated'} · ${skipped.length} skipped`)
  console.log()
}

export function runPluginsUpdateCommand(options: PluginUpdateOptions): void {
  const configuredPlugins = loadConfiguredPlugins()
  const exclude = new Set((options.exclude || []).map((item) => item.trim()).filter(Boolean))
  const results: PluginUpdateResult[] = []

  for (const rawSpec of configuredPlugins) {
    const parsed = parsePluginSpec(rawSpec)

    if (parsed.kind !== 'registry' || !parsed.moduleName) {
      results.push({
        plugin: rawSpec,
        action: 'skipped',
        reason:
          parsed.kind === 'local'
            ? 'local plugin'
            : parsed.kind === 'remote'
              ? 'remote/git plugin'
              : 'unsupported spec',
      })
      continue
    }

    if (exclude.has(parsed.moduleName)) {
      results.push({
        plugin: rawSpec,
        action: 'skipped',
        reason: 'excluded',
      })
      continue
    }

    if (!options.includePinned && parsed.versionSpec && parsed.versionSpec !== 'latest') {
      results.push({
        plugin: rawSpec,
        action: 'skipped',
        reason: `pinned version (${parsed.versionSpec})`,
      })
      continue
    }

    if (options.dryRun) {
      results.push({
        plugin: `${parsed.moduleName}@latest`,
        action: 'updated',
      })
      continue
    }

    updatePlugin(parsed.moduleName)
    results.push({
      plugin: `${parsed.moduleName}@latest`,
      action: 'updated',
    })
  }

  printSummary(results, options.dryRun === true)
}
