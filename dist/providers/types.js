// Shared types for multi-provider usage checking
export const DEFAULT_PROVIDER_TIMEOUT_MS = 12_000;
export function fetchWithTimeout(url, init, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS) {
    const signal = AbortSignal.timeout(timeoutMs);
    const mergedInit = { ...init, signal };
    return fetch(url, mergedInit);
}
//# sourceMappingURL=types.js.map