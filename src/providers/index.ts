// Provider registry and parallel fetch orchestrator

import { listAccounts } from '../store.js'
import type { ProviderResult, UsageProvider } from './types.js'

import { claudeProvider } from './claude.js'
import { codexProvider } from './codex.js'
import { geminiProvider } from './gemini.js'
import { copilotProvider } from './copilot.js'
import { openRouterProvider } from './openrouter.js'
import { kimiProvider } from './kimi.js'
import { miniMaxProvider } from './minimax.js'
import { zaiProvider } from './zai.js'
import { nanoGptProvider } from './nanogpt.js'
import { syntheticProvider } from './synthetic.js'
import { chutesProvider } from './chutes.js'

const DEFAULT_USAGE_TIMEOUT_MS = 15_000
const CODEX_USAGE_TIMEOUT_BASE_MS = 15_000
const CODEX_USAGE_TIMEOUT_PER_ACCOUNT_MS = 1_000

function getUsageProviderTimeoutMs(provider: UsageProvider, defaultTimeoutMs: number): number {
	if (provider.id !== 'codex') return defaultTimeoutMs

	const accountCount = listAccounts().length
	return Math.max(defaultTimeoutMs, CODEX_USAGE_TIMEOUT_BASE_MS + accountCount * CODEX_USAGE_TIMEOUT_PER_ACCOUNT_MS)
}

/** All registered providers in display order */
export const allProviders: UsageProvider[] = [
	claudeProvider,
	codexProvider,
	geminiProvider,
	copilotProvider,
	openRouterProvider,
	kimiProvider,
	miniMaxProvider,
	zaiProvider,
	nanoGptProvider,
	syntheticProvider,
	chutesProvider,
]

/** Get a provider by ID */
export function getProvider(id: string): UsageProvider | undefined {
	return allProviders.find(p => p.id === id)
}

/** Fetch usage from all providers in parallel with a per-provider timeout */
export async function fetchAllUsage(opts?: { providerIds?: string[]; timeoutMs?: number }): Promise<ProviderResult[]> {
	const { providerIds, timeoutMs = DEFAULT_USAGE_TIMEOUT_MS } = opts ?? {}

	const providers = providerIds ? allProviders.filter(p => providerIds.includes(p.id)) : allProviders

	const results = await Promise.allSettled(
		providers.map(async (provider): Promise<ProviderResult> => {
			const providerTimeoutMs = getUsageProviderTimeoutMs(provider, timeoutMs)
			// Race between the provider fetch and a timeout
			const fetchPromise = provider.fetchUsage()
			const timeoutPromise = new Promise<ProviderResult>(resolve =>
				setTimeout(
					() =>
						resolve({
							providerId: provider.id,
							providerName: provider.name,
							billingType: provider.billingType,
							status: 'error',
							error: `Timeout after ${providerTimeoutMs}ms`,
							fetchedAt: Date.now(),
						}),
					providerTimeoutMs,
				),
			)
			return Promise.race([fetchPromise, timeoutPromise])
		}),
	)

	return results.map((r, i) =>
		r.status === 'fulfilled'
			? r.value
			: {
					providerId: providers[i].id,
					providerName: providers[i].name,
					billingType: providers[i].billingType,
					status: 'error' as const,
					error: `${r.reason}`,
					fetchedAt: Date.now(),
				},
	)
}

export type { ProviderResult, UsageProvider } from './types.js'
