import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const LOG_PATH_ENV = 'OPENCODE_ENHANCER_LOG_PATH'
const LEGACY_LOG_PATH_ENV = 'CODEX_SOFT_LOG_PATH'
const LEGACY_DEFAULT_LOG_DIR = path.join(os.homedir(), '.config', 'opencode-multi-auth', 'logs')
const DEFAULT_LOG_DIR = path.join(os.homedir(), '.config', 'opencode-enhancer', 'logs')
const DEFAULT_LOG_FILE = 'codex-soft.log'
const MAX_LOG_LINES = 400
let logLocationChecked = false

function getConfiguredLogPath(): string {
  const override = process.env[LOG_PATH_ENV] || process.env[LEGACY_LOG_PATH_ENV]
  return override && override.trim() ? path.resolve(override.trim()) : path.join(DEFAULT_LOG_DIR, DEFAULT_LOG_FILE)
}

const LOG_FILE = getConfiguredLogPath()

function migrateLegacyLogLocation(): void {
  if (logLocationChecked) return
  logLocationChecked = true

  if (process.env[LOG_PATH_ENV]?.trim() || process.env[LEGACY_LOG_PATH_ENV]?.trim()) {
    return
  }

  if (fs.existsSync(LEGACY_DEFAULT_LOG_DIR) && !fs.existsSync(DEFAULT_LOG_DIR)) {
    try {
      fs.mkdirSync(path.dirname(DEFAULT_LOG_DIR), { recursive: true, mode: 0o700 })
      fs.renameSync(LEGACY_DEFAULT_LOG_DIR, DEFAULT_LOG_DIR)
      return
    } catch {
      // Fall back to moving the log file only.
    }
  }

  const legacyLogFile = path.join(LEGACY_DEFAULT_LOG_DIR, DEFAULT_LOG_FILE)
  if (!fs.existsSync(legacyLogFile) || fs.existsSync(LOG_FILE)) return

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 })
  fs.renameSync(legacyLogFile, LOG_FILE)
}

function ensureDir(): void {
  migrateLegacyLogLocation()
  const dir = path.dirname(LOG_FILE)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

function sanitize(message: string): string {
  return message
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt]')
    .replace(/\bsk-[A-Za-z0-9]{10,}\b/g, '[token]')
}

function append(level: string, message: string): void {
  try {
    ensureDir()
    const line = `${new Date().toISOString()} [${level}] ${sanitize(message)}\n`
    fs.appendFileSync(LOG_FILE, line, { encoding: 'utf-8', mode: 0o600 })
  } catch {
    // Ignore log write failures
  }
}

export function logInfo(message: string): void {
  append('info', message)
}

export function logWarn(message: string): void {
  append('warn', message)
}

export function logError(message: string): void {
  append('error', message)
}

export function getLogPath(): string {
  return LOG_FILE
}

export function readLogTail(maxLines = MAX_LOG_LINES): string[] {
  try {
    if (!fs.existsSync(LOG_FILE)) return []
    const data = fs.readFileSync(LOG_FILE, 'utf-8')
    const lines = data.split('\n').filter(Boolean)
    return lines.slice(Math.max(0, lines.length - maxLines))
  } catch {
    return []
  }
}
