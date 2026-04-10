import { generatePKCE } from '@openauthjs/openauth/pkce';
import { randomBytes } from 'node:crypto';
import * as http from 'http';
import * as url from 'url';
import { addAccount, updateAccount, loadStore } from './store.js';
import { clearAuthInvalid } from './rotation.js';
import { decodeJwtPayload } from './jwt.js';
import { getAccountIdFromClaims, getEmailFromClaims, getExpiryFromClaims, getNameFromClaims } from './codex-auth.js';
const OPENAI_ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${OPENAI_ISSUER}/oauth/authorize`;
const TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`;
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_REDIRECT_PORTS = [1455, 1456, 1457, 1458, 1459];
const SCOPES = ['openid', 'profile', 'email', 'offline_access'];
function getRedirectUri(port) {
    return `http://localhost:${port}/auth/callback`;
}
export async function createAuthorizationFlow(port) {
    const pkce = await generatePKCE();
    const state = randomBytes(16).toString('hex');
    const redirectPort = port || DEFAULT_REDIRECT_PORTS[0];
    const redirectUri = getRedirectUri(redirectPort);
    const authUrl = new URL(AUTHORIZE_URL);
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES.join(' '));
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('audience', 'https://api.openai.com/v1');
    authUrl.searchParams.set('id_token_add_organizations', 'true');
    authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
    authUrl.searchParams.set('originator', 'codex_cli_rs');
    return { pkce, state, url: authUrl.toString(), redirectUri, port: redirectPort };
}
function buildGeneratedAlias(email) {
    const store = loadStore();
    const existingAliases = new Set(Object.keys(store.accounts));
    const emailLocalPart = email?.split('@')[0]?.trim().toLowerCase();
    const sanitizedBase = (emailLocalPart || 'account')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    const base = sanitizedBase || 'account';
    while (true) {
        const suffix = randomBytes(3).toString('hex');
        const alias = `${base}-${suffix}`;
        if (!existingAliases.has(alias))
            return alias;
    }
}
function tryListenOnPort(server, port) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.off('error', onError);
            reject(err);
        };
        server.on('error', onError);
        server.listen(port, () => {
            server.off('error', onError);
            resolve();
        });
    });
}
async function findAvailablePort(server, ports) {
    for (const port of ports) {
        try {
            await tryListenOnPort(server, port);
            return port;
        }
        catch (err) {
            if (err.code === 'EADDRINUSE') {
                continue;
            }
            throw err;
        }
    }
    throw new Error(`All ports ${ports.join(', ')} are in use. Stop Codex CLI if running.`);
}
export async function loginAccount(alias, flow, options) {
    const ports = DEFAULT_REDIRECT_PORTS;
    let activeFlow = flow;
    let server = null;
    const timeoutMs = Math.max(30_000, options?.timeoutMs ?? 5 * 60 * 1000);
    return new Promise(async (resolve, reject) => {
        let finished = false;
        let timeout = null;
        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            if (server) {
                server.close();
                server = null;
            }
        };
        const finish = (fn) => {
            if (finished)
                return;
            finished = true;
            cleanup();
            fn();
        };
        server = http.createServer(async (req, res) => {
            if (!req.url?.startsWith('/auth/callback')) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }
            if (!activeFlow) {
                res.writeHead(500);
                res.end('No active flow');
                finish(() => reject(new Error('No active flow')));
                return;
            }
            const parsedUrl = url.parse(req.url, true);
            const code = parsedUrl.query.code;
            const returnedState = parsedUrl.query.state;
            if (!code) {
                res.writeHead(400);
                res.end('No authorization code received');
                finish(() => reject(new Error('No authorization code')));
                return;
            }
            if (returnedState && returnedState !== activeFlow.state) {
                res.writeHead(400);
                res.end('Invalid state');
                finish(() => reject(new Error('Invalid state')));
                return;
            }
            try {
                const tokenRes = await fetch(TOKEN_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        client_id: CLIENT_ID,
                        code,
                        code_verifier: activeFlow.pkce.verifier,
                        redirect_uri: activeFlow.redirectUri
                    })
                });
                if (!tokenRes.ok) {
                    throw new Error(`Token exchange failed: ${tokenRes.status}`);
                }
                const tokens = (await tokenRes.json());
                if (!tokens.refresh_token) {
                    throw new Error('Token exchange did not return a refresh_token');
                }
                const now = Date.now();
                const accessClaims = decodeJwtPayload(tokens.access_token);
                const idClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
                const expiresAt = getExpiryFromClaims(accessClaims) || getExpiryFromClaims(idClaims) || now + tokens.expires_in * 1000;
                let email = getEmailFromClaims(idClaims) || getEmailFromClaims(accessClaims);
                let name = getNameFromClaims(idClaims) || getNameFromClaims(accessClaims);
                try {
                    const userRes = await fetch(`${OPENAI_ISSUER}/userinfo`, {
                        headers: { Authorization: `Bearer ${tokens.access_token}` }
                    });
                    if (userRes.ok) {
                        const user = (await userRes.json());
                        email = user.email || email;
                        name = user.name || undefined;
                    }
                }
                catch {
                    /* user info fetch is non-critical */
                }
                const accountId = getAccountIdFromClaims(idClaims) ||
                    getAccountIdFromClaims(accessClaims);
                const resolvedAlias = alias || buildGeneratedAlias(email);
                const store = addAccount(resolvedAlias, {
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                    idToken: tokens.id_token,
                    accountId,
                    expiresAt,
                    email,
                    name,
                    lastRefresh: new Date(now).toISOString(),
                    lastSeenAt: now,
                    source: 'opencode',
                    authInvalid: false,
                    authInvalidatedAt: undefined
                });
                const account = store.accounts[resolvedAlias];
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
          <html>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1>Account "${resolvedAlias}" authenticated!</h1>
              <p>${email || 'Unknown email'}</p>
              <p>You can close this window.</p>
            </body>
          </html>
        `);
                finish(() => resolve(account));
            }
            catch (err) {
                res.writeHead(500);
                res.end('Authentication failed');
                finish(() => reject(err));
            }
        });
        try {
            const actualPort = await findAvailablePort(server, ports);
            if (!activeFlow || activeFlow.port !== actualPort) {
                activeFlow = await createAuthorizationFlow(actualPort);
            }
            console.log(`\n[enhancer] Login for account "${alias || 'new account'}"`);
            console.log(`[enhancer] Open this URL in your browser:\n`);
            console.log(`  ${activeFlow.url}\n`);
            console.log(`[enhancer] Waiting for callback on port ${actualPort}...`);
        }
        catch (err) {
            finish(() => reject(err));
            return;
        }
        timeout = setTimeout(() => {
            finish(() => reject(new Error(`Login timeout after ${Math.round(timeoutMs / 1000)}s - no callback received`)));
        }, timeoutMs);
    });
}
export async function refreshToken(alias) {
    const store = loadStore();
    const account = store.accounts[alias];
    if (!account?.refreshToken) {
        console.error(`[enhancer] No refresh token for ${alias}`);
        return null;
    }
    try {
        const tokenRes = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: CLIENT_ID,
                refresh_token: account.refreshToken
            })
        });
        if (!tokenRes.ok) {
            console.error(`[enhancer] Refresh failed for ${alias}: ${tokenRes.status}`);
            if (tokenRes.status === 401 || tokenRes.status === 403) {
                try {
                    updateAccount(alias, {
                        authInvalid: true,
                        authInvalidatedAt: Date.now()
                    });
                }
                catch {
                    // ignore
                }
            }
            return null;
        }
        const tokens = (await tokenRes.json());
        const accessClaims = decodeJwtPayload(tokens.access_token);
        const idClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
        const expiresAt = getExpiryFromClaims(accessClaims) || getExpiryFromClaims(idClaims) || Date.now() + tokens.expires_in * 1000;
        const updates = {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || account.refreshToken,
            expiresAt,
            lastRefresh: new Date().toISOString(),
            idToken: tokens.id_token || account.idToken,
            accountId: getAccountIdFromClaims(idClaims) ||
                getAccountIdFromClaims(accessClaims) ||
                account.accountId
        };
        const updatedStore = updateAccount(alias, updates);
        clearAuthInvalid(alias);
        return updatedStore.accounts[alias];
    }
    catch (err) {
        console.error(`[enhancer] Refresh error for ${alias}:`, err);
        return null;
    }
}
export async function ensureValidToken(alias) {
    const store = loadStore();
    const account = store.accounts[alias];
    if (!account)
        return null;
    const bufferMs = 5 * 60 * 1000;
    if (account.expiresAt < Date.now() + bufferMs) {
        console.log(`[enhancer] Refreshing token for ${alias}`);
        const refreshed = await refreshToken(alias);
        return refreshed?.accessToken || null;
    }
    return account.accessToken;
}
//# sourceMappingURL=auth.js.map