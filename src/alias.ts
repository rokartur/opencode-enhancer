import { randomBytes } from 'node:crypto'

interface BuildRandomizedAliasOptions {
  preferredAlias?: string
  email?: string
  accountId?: string
  existingAliases: Set<string>
  fallbackBase?: string
}

function sanitizeAliasBase(value: string | undefined): string {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function buildRandomizedAlias(options: BuildRandomizedAliasOptions): string {
  const preferredAlias = sanitizeAliasBase(options.preferredAlias)
  const emailLocalPart = sanitizeAliasBase(options.email?.split('@')[0])
  const accountIdBase = sanitizeAliasBase(options.accountId?.slice(0, 8))
  const fallbackBase = sanitizeAliasBase(options.fallbackBase) || 'account'
  const base = preferredAlias || emailLocalPart || accountIdBase || fallbackBase

  while (true) {
    const suffix = randomBytes(3).toString('hex')
    const alias = `${base}-${suffix}`
    if (!options.existingAliases.has(alias)) return alias
  }
}