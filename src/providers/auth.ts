// Read auth tokens from OpenCode's auth.json file
// Located at ~/.local/share/opencode/auth.json (XDG_DATA_HOME/opencode/auth.json)

import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);

interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}

interface ApiKeyCredential {
  type: "apikey" | "api";
  key: string;
}

type AuthCredential = OAuthCredential | ApiKeyCredential;

interface OpenCodeAuth {
  [key: string]: AuthCredential | undefined;
}

let cachedAuth: OpenCodeAuth | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 10_000; // 10 seconds

const AUTH_KEY_ALIASES: Record<string, string[]> = {
  opencode: ["opencode-go"],
  "opencode-go": ["opencode"],
  google: ["google.oauth"],
  "google.oauth": ["google"],
};

function getAuthFileCandidates(): string[] {
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const candidates = [
    join(xdgData, "opencode", "auth.json"),
    join(xdgData, "opencode", "auth.js"),
    join(xdgConfig, "opencode", "auth.json"),
    join(xdgConfig, "opencode", "auth.js"),
  ];

  return [...new Set(candidates)];
}

function getAuthFilePath(): string {
  return (
    getAuthFileCandidates().find((filePath) => existsSync(filePath)) || getAuthFileCandidates()[0]
  );
}

function parseAuthObject(value: unknown): OpenCodeAuth | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as OpenCodeAuth;
}

function parseAuthJsSource(raw: string): OpenCodeAuth | undefined {
  const trimmed = raw.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^export\s+default\s+/, "").replace(/;\s*$/, ""),
    trimmed.replace(/^module\.exports\s*=\s*/, "").replace(/;\s*$/, ""),
  ];

  for (const candidate of candidates) {
    if (
      !candidate ||
      (candidate === trimmed &&
        (trimmed.startsWith("export ") || trimmed.startsWith("module.exports")))
    ) {
      continue;
    }

    try {
      const parsed = Function(`"use strict"; return (${candidate})`)() as unknown;
      const auth = parseAuthObject(parsed);
      if (auth) return auth;
    } catch {
      continue;
    }
  }

  return undefined;
}

function loadAuthFromPath(filePath: string): OpenCodeAuth | undefined {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const fromJson = parseAuthObject(JSON.parse(raw));
    if (fromJson) return fromJson;
  } catch {
    // Fall through to .js parsing / require below.
  }

  if (!filePath.endsWith(".js")) return undefined;

  try {
    const resolved = require.resolve(filePath);
    delete require.cache[resolved];
    const loaded = require(filePath) as unknown;
    const auth = parseAuthObject((loaded as { default?: unknown })?.default ?? loaded);
    if (auth) return auth;
  } catch {
    // Fall through to raw object-literal parsing.
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    return parseAuthJsSource(raw);
  } catch {
    return undefined;
  }
}

function getCredential(auth: OpenCodeAuth, key: string): AuthCredential | undefined {
  const keys = [key, ...(AUTH_KEY_ALIASES[key] || [])];
  for (const candidate of keys) {
    const credential = auth[candidate];
    if (credential) return credential;
  }
  return undefined;
}

function loadAuthFile(): OpenCodeAuth {
  const now = Date.now();
  if (cachedAuth && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedAuth;
  }

  const filePaths = getAuthFileCandidates();
  const existingPaths = filePaths.filter((filePath) => existsSync(filePath));
  if (existingPaths.length === 0) {
    cachedAuth = {};
    cacheTimestamp = now;
    return cachedAuth;
  }

  const mergedAuth: OpenCodeAuth = {};
  for (const filePath of existingPaths) {
    const parsed = loadAuthFromPath(filePath);
    if (parsed) {
      Object.assign(mergedAuth, parsed);
    }
  }

  cachedAuth = mergedAuth;
  cacheTimestamp = now;
  return cachedAuth;
}

/** Get an OAuth access token for a provider key (e.g. 'anthropic', 'openai', 'github-copilot') */
export function getOAuthToken(key: string): string | undefined {
  const auth = loadAuthFile();
  const cred = getCredential(auth, key);
  if (!cred || cred.type !== "oauth") return undefined;
  return cred.access || undefined;
}

/** Get an OAuth refresh token for a provider key */
export function getOAuthRefreshToken(key: string): string | undefined {
  const auth = loadAuthFile();
  const cred = getCredential(auth, key);
  if (!cred || cred.type !== "oauth") return undefined;
  return cred.refresh || undefined;
}

/** Get an OAuth credential object for a provider key */
export function getOAuthCredential(key: string): OAuthCredential | undefined {
  const auth = loadAuthFile();
  const cred = getCredential(auth, key);
  if (!cred || cred.type !== "oauth") return undefined;
  return cred as OAuthCredential;
}

/** Get an API key for a provider key (e.g. 'openrouter', 'opencode', 'kimi-for-coding') */
export function getApiKey(key: string): string | undefined {
  const auth = loadAuthFile();
  const cred = getCredential(auth, key);
  if (!cred) return undefined;
  if (cred.type === "apikey" || cred.type === "api") return cred.key || undefined;
  // Some providers may store key in access field with oauth type
  if (cred.type === "oauth") return cred.access || undefined;
  return undefined;
}

/** Check if a provider key has any credential configured */
export function hasCredential(key: string): boolean {
  const auth = loadAuthFile();
  const cred = getCredential(auth, key);
  if (!cred) return false;
  if (cred.type === "apikey" || cred.type === "api") return !!cred.key;
  if (cred.type === "oauth") return !!cred.access;
  return false;
}

/** Invalidate the auth cache (useful after token refresh) */
export function invalidateAuthCache(): void {
  cachedAuth = null;
  cacheTimestamp = 0;
}

/** Get the path to the auth file (for display purposes) */
export function getAuthPath(): string {
  return getAuthFilePath();
}

// Also check Gemini CLI oauth creds at ~/.gemini/oauth_creds.json
export interface GeminiOAuthCreds {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

function buildGeminiOAuthCreds(
  refreshToken: string,
  clientId?: string,
  clientSecret?: string,
): GeminiOAuthCreds | undefined {
  const resolvedClientId =
    clientId ||
    process.env.OPENCODE_ENHANCER_GOOGLE_CLIENT_ID ||
    process.env.OPENCODE_MULTI_AUTH_GOOGLE_CLIENT_ID;
  const resolvedClientSecret =
    clientSecret ||
    process.env.OPENCODE_ENHANCER_GOOGLE_CLIENT_SECRET ||
    process.env.OPENCODE_MULTI_AUTH_GOOGLE_CLIENT_SECRET;

  if (!resolvedClientId || !resolvedClientSecret) return undefined;

  return {
    client_id: resolvedClientId,
    client_secret: resolvedClientSecret,
    refresh_token: refreshToken,
  };
}

export function getGeminiOAuthCreds(): GeminiOAuthCreds | undefined {
  // Try multiple locations
  const paths = [
    join(homedir(), ".gemini", "oauth_creds.json"),
    join(homedir(), ".config", "opencode", "antigravity-accounts.json"),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw);

      if (parsed.refresh_token) {
        return buildGeminiOAuthCreds(parsed.refresh_token, parsed.client_id, parsed.client_secret);
      }

      // Antigravity accounts format — take first account
      if (Array.isArray(parsed)) {
        const first = parsed[0];
        if (first?.refresh_token) {
          return buildGeminiOAuthCreds(first.refresh_token, first.client_id, first.client_secret);
        }
      }
    } catch {
      continue;
    }
  }

  // Also check opencode auth.json for google.oauth
  const auth = loadAuthFile();
  const googleOAuth = auth["google.oauth"] || auth["google"];
  if (googleOAuth && googleOAuth.type === "oauth" && googleOAuth.refresh) {
    return buildGeminiOAuthCreds(googleOAuth.refresh);
  }

  return undefined;
}
