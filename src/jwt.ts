export function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=')
    const decoded = Buffer.from(padded, 'base64').toString('utf-8')
    return JSON.parse(decoded) as Record<string, any>
  } catch {
    return null
  }
}