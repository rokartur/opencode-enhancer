interface OAuthCredential {
    type: "oauth";
    access: string;
    refresh?: string;
    expires?: number;
    accountId?: string;
}
/** Get an OAuth access token for a provider key (e.g. 'anthropic', 'openai', 'github-copilot') */
export declare function getOAuthToken(key: string): string | undefined;
/** Get an OAuth refresh token for a provider key */
export declare function getOAuthRefreshToken(key: string): string | undefined;
/** Get an OAuth credential object for a provider key */
export declare function getOAuthCredential(key: string): OAuthCredential | undefined;
/** Get an API key for a provider key (e.g. 'openrouter', 'opencode', 'kimi-for-coding') */
export declare function getApiKey(key: string): string | undefined;
/** Check if a provider key has any credential configured */
export declare function hasCredential(key: string): boolean;
/** Invalidate the auth cache (useful after token refresh) */
export declare function invalidateAuthCache(): void;
/** Get the path to the auth file (for display purposes) */
export declare function getAuthPath(): string;
export interface GeminiOAuthCreds {
    client_id: string;
    client_secret: string;
    refresh_token: string;
}
export declare function getGeminiOAuthCreds(): GeminiOAuthCreds | undefined;
export {};
//# sourceMappingURL=auth.d.ts.map