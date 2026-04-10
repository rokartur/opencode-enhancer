// Read auth tokens from OpenCode's auth.json file
// Located at ~/.local/share/opencode/auth.json (XDG_DATA_HOME/opencode/auth.json)
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir } from 'node:os';
const require = createRequire(import.meta.url);
let cachedAuth = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 10_000; // 10 seconds
const AUTH_KEY_ALIASES = {
    opencode: ['opencode-go'],
    'opencode-go': ['opencode'],
    google: ['google.oauth'],
    'google.oauth': ['google'],
};
function getAuthFileCandidates() {
    const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const candidates = [
        join(xdgData, 'opencode', 'auth.json'),
        join(xdgData, 'opencode', 'auth.js'),
        join(xdgConfig, 'opencode', 'auth.json'),
        join(xdgConfig, 'opencode', 'auth.js'),
    ];
    return [...new Set(candidates)];
}
function getAuthFilePath() {
    return getAuthFileCandidates().find((filePath) => existsSync(filePath)) || getAuthFileCandidates()[0];
}
function parseAuthObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    return value;
}
function parseAuthJsSource(raw) {
    const trimmed = raw.trim();
    const candidates = [
        trimmed,
        trimmed.replace(/^export\s+default\s+/, '').replace(/;\s*$/, ''),
        trimmed.replace(/^module\.exports\s*=\s*/, '').replace(/;\s*$/, ''),
    ];
    for (const candidate of candidates) {
        if (!candidate || candidate === trimmed && (trimmed.startsWith('export ') || trimmed.startsWith('module.exports'))) {
            continue;
        }
        try {
            const parsed = Function(`"use strict"; return (${candidate})`)();
            const auth = parseAuthObject(parsed);
            if (auth)
                return auth;
        }
        catch {
            continue;
        }
    }
    return undefined;
}
function loadAuthFromPath(filePath) {
    try {
        const raw = readFileSync(filePath, 'utf-8');
        const fromJson = parseAuthObject(JSON.parse(raw));
        if (fromJson)
            return fromJson;
    }
    catch {
        // Fall through to .js parsing / require below.
    }
    if (!filePath.endsWith('.js'))
        return undefined;
    try {
        const resolved = require.resolve(filePath);
        delete require.cache[resolved];
        const loaded = require(filePath);
        const auth = parseAuthObject(loaded?.default ?? loaded);
        if (auth)
            return auth;
    }
    catch {
        // Fall through to raw object-literal parsing.
    }
    try {
        const raw = readFileSync(filePath, 'utf-8');
        return parseAuthJsSource(raw);
    }
    catch {
        return undefined;
    }
}
function getCredential(auth, key) {
    const keys = [key, ...(AUTH_KEY_ALIASES[key] || [])];
    for (const candidate of keys) {
        const credential = auth[candidate];
        if (credential)
            return credential;
    }
    return undefined;
}
function loadAuthFile() {
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
    const mergedAuth = {};
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
export function getOAuthToken(key) {
    const auth = loadAuthFile();
    const cred = getCredential(auth, key);
    if (!cred || cred.type !== 'oauth')
        return undefined;
    return cred.access || undefined;
}
/** Get an OAuth refresh token for a provider key */
export function getOAuthRefreshToken(key) {
    const auth = loadAuthFile();
    const cred = getCredential(auth, key);
    if (!cred || cred.type !== 'oauth')
        return undefined;
    return cred.refresh || undefined;
}
/** Get an OAuth credential object for a provider key */
export function getOAuthCredential(key) {
    const auth = loadAuthFile();
    const cred = getCredential(auth, key);
    if (!cred || cred.type !== 'oauth')
        return undefined;
    return cred;
}
/** Get an API key for a provider key (e.g. 'openrouter', 'opencode', 'kimi-for-coding') */
export function getApiKey(key) {
    const auth = loadAuthFile();
    const cred = getCredential(auth, key);
    if (!cred)
        return undefined;
    if (cred.type === 'apikey' || cred.type === 'api')
        return cred.key || undefined;
    // Some providers may store key in access field with oauth type
    if (cred.type === 'oauth')
        return cred.access || undefined;
    return undefined;
}
/** Check if a provider key has any credential configured */
export function hasCredential(key) {
    const auth = loadAuthFile();
    const cred = getCredential(auth, key);
    if (!cred)
        return false;
    if (cred.type === 'apikey' || cred.type === 'api')
        return !!cred.key;
    if (cred.type === 'oauth')
        return !!cred.access;
    return false;
}
/** Invalidate the auth cache (useful after token refresh) */
export function invalidateAuthCache() {
    cachedAuth = null;
    cacheTimestamp = 0;
}
/** Get the path to the auth file (for display purposes) */
export function getAuthPath() {
    return getAuthFilePath();
}
export function getGeminiOAuthCreds() {
    // Try multiple locations
    const paths = [
        join(homedir(), '.gemini', 'oauth_creds.json'),
        join(homedir(), '.config', 'opencode', 'antigravity-accounts.json'),
    ];
    for (const p of paths) {
        if (!existsSync(p))
            continue;
        try {
            const raw = readFileSync(p, 'utf-8');
            const parsed = JSON.parse(raw);
            // Direct oauth_creds.json format
            if (parsed.client_id && parsed.refresh_token) {
                return parsed;
            }
            // Antigravity accounts format — take first account
            if (Array.isArray(parsed)) {
                const first = parsed[0];
                if (first?.client_id && first?.refresh_token) {
                    return first;
                }
            }
        }
        catch {
            continue;
        }
    }
    // Also check opencode auth.json for google.oauth
    const auth = loadAuthFile();
    const googleOAuth = auth['google.oauth'] || auth['google'];
    if (googleOAuth && googleOAuth.type === 'oauth' && googleOAuth.refresh) {
        const clientId = process.env.OPENCODE_ENHANCER_GOOGLE_CLIENT_ID || process.env.OPENCODE_MULTI_AUTH_GOOGLE_CLIENT_ID || '';
        const clientSecret = process.env.OPENCODE_ENHANCER_GOOGLE_CLIENT_SECRET || process.env.OPENCODE_MULTI_AUTH_GOOGLE_CLIENT_SECRET || '';
        if (!clientId || !clientSecret)
            return undefined;
        return {
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: googleOAuth.refresh,
        };
    }
    return undefined;
}
//# sourceMappingURL=auth.js.map