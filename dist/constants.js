export const PROVIDER_ID = 'openai';
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
export const REDIRECT_PORT = 1455;
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
export const URL_PATHS = {
    RESPONSES: '/responses',
    CODEX_RESPONSES: '/codex/responses',
};
export const OPENAI_HEADERS = {
    BETA: 'OpenAI-Beta',
    ACCOUNT_ID: 'chatgpt-account-id',
    ORIGINATOR: 'originator',
    SESSION_ID: 'session_id',
    CONVERSATION_ID: 'conversation_id',
};
export const OPENAI_HEADER_VALUES = {
    BETA_RESPONSES: 'responses=experimental',
    ORIGINATOR_CODEX: 'codex_cli_rs',
};
export const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
export const TIMEOUTS = {
    UPSTREAM_FETCH_MS: 120_000,
    AUTH_SYNC_COOLDOWN_MS: 10_000,
    STORE_WRITE_DEBOUNCE_MS: 2_000,
    PROVIDER_FETCH_TIMEOUT_MS: 15_000,
};
export const AUTH_SYNC_COOLDOWN_MS = 10_000;
//# sourceMappingURL=constants.js.map