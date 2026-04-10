// Provider registry and parallel fetch orchestrator
import { claudeProvider } from './claude.js';
import { codexProvider } from './codex.js';
import { geminiProvider } from './gemini.js';
import { copilotProvider } from './copilot.js';
import { openRouterProvider } from './openrouter.js';
import { openCodeProvider } from './opencode.js';
import { kimiProvider } from './kimi.js';
import { miniMaxProvider } from './minimax.js';
import { zaiProvider } from './zai.js';
import { nanoGptProvider } from './nanogpt.js';
import { syntheticProvider } from './synthetic.js';
import { chutesProvider } from './chutes.js';
/** All registered providers in display order */
export const allProviders = [
    claudeProvider,
    codexProvider,
    geminiProvider,
    copilotProvider,
    openRouterProvider,
    openCodeProvider,
    kimiProvider,
    miniMaxProvider,
    zaiProvider,
    nanoGptProvider,
    syntheticProvider,
    chutesProvider,
];
/** Get a provider by ID */
export function getProvider(id) {
    return allProviders.find((p) => p.id === id);
}
/** Fetch usage from all providers in parallel with a per-provider timeout */
export async function fetchAllUsage(opts) {
    const { providerIds, timeoutMs = 15_000 } = opts ?? {};
    const providers = providerIds
        ? allProviders.filter((p) => providerIds.includes(p.id))
        : allProviders;
    const results = await Promise.allSettled(providers.map(async (provider) => {
        // Race between the provider fetch and a timeout
        const fetchPromise = provider.fetchUsage();
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve({
            providerId: provider.id,
            providerName: provider.name,
            billingType: provider.billingType,
            status: 'error',
            error: `Timeout after ${timeoutMs}ms`,
            fetchedAt: Date.now(),
        }), timeoutMs));
        return Promise.race([fetchPromise, timeoutPromise]);
    }));
    return results.map((r, i) => r.status === 'fulfilled'
        ? r.value
        : {
            providerId: providers[i].id,
            providerName: providers[i].name,
            billingType: providers[i].billingType,
            status: 'error',
            error: `${r.reason}`,
            fetchedAt: Date.now(),
        });
}
//# sourceMappingURL=index.js.map