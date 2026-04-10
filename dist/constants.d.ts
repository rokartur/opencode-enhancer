export declare const PROVIDER_ID = "openai";
export declare const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export declare const REDIRECT_PORT = 1455;
export declare const REDIRECT_URI = "http://localhost:1455/auth/callback";
export declare const URL_PATHS: {
    readonly RESPONSES: "/responses";
    readonly CODEX_RESPONSES: "/codex/responses";
};
export declare const OPENAI_HEADERS: {
    readonly BETA: "OpenAI-Beta";
    readonly ACCOUNT_ID: "chatgpt-account-id";
    readonly ORIGINATOR: "originator";
    readonly SESSION_ID: "session_id";
    readonly CONVERSATION_ID: "conversation_id";
};
export declare const OPENAI_HEADER_VALUES: {
    readonly BETA_RESPONSES: "responses=experimental";
    readonly ORIGINATOR_CODEX: "codex_cli_rs";
};
export declare const JWT_CLAIM_PATH = "https://api.openai.com/auth";
export declare const TIMEOUTS: {
    readonly UPSTREAM_FETCH_MS: 120000;
    readonly AUTH_SYNC_COOLDOWN_MS: 10000;
    readonly STORE_WRITE_DEBOUNCE_MS: 2000;
    readonly PROVIDER_FETCH_TIMEOUT_MS: 15000;
};
export declare const AUTH_SYNC_COOLDOWN_MS = 10000;
//# sourceMappingURL=constants.d.ts.map