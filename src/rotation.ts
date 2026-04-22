import { getStoreDiagnostics, loadStore, saveStore, updateAccount } from "./store.js";
import { ensureValidToken } from "./auth.js";
import { isForceActive, checkAndAutoClearForce, getForceState, clearForce } from "./force-mode.js";
import { getRuntimeSettings, calculateWeightedSelection } from "./settings.js";
import { compareAccountsByUsagePriority, getMinRemaining } from "./account-ranking.js";
import type { AccountCredentials, AccountRateLimits, DEFAULT_CONFIG } from "./types.js";
import { AUTO_SWITCH_THRESHOLD_DEFAULT } from "./types.js";

export interface RotationResult {
  account: AccountCredentials;
  token: string;
  forceState?: {
    active: boolean;
    alias: string | null;
    remainingMs: number;
  };
}

const HEALTH_HYSTERESIS_MS = 10_000;
const RECENT_FAILURE_WINDOW_MS = 60_000;

function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function isDebugEnabled(): boolean {
  return readEnv("OPENCODE_ENHANCER_DEBUG", "OPENCODE_MULTI_AUTH_DEBUG") === "1";
}

export function selectBestAvailableAccount(
  excludeAlias?: string,
  threshold?: number,
): string | null {
  const store = loadStore();
  const now = Date.now();
  const aliases = Object.keys(store.accounts);

  const eligible = aliases.filter((alias) => {
    const acc = store.accounts[alias];
    if (excludeAlias && alias === excludeAlias) return false;
    if (acc.rateLimitedUntil && acc.rateLimitedUntil > now) return false;
    if (acc.modelUnsupportedUntil && acc.modelUnsupportedUntil > now) return false;
    if (acc.workspaceDeactivatedUntil && acc.workspaceDeactivatedUntil > now) return false;
    if (acc.authInvalid) return false;
    if (acc.enabled === false) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  const healthMap = new Map<string, AccountHealth>();
  for (const alias of eligible) {
    healthMap.set(alias, evaluateAccountHealth(store.accounts[alias], now));
  }

  eligible.sort((a, b) => {
    return compareAccountsByUsagePriority(store.accounts[a], store.accounts[b], {
      healthPriorityA: healthMap.get(a)?.priority,
      healthPriorityB: healthMap.get(b)?.priority,
      now,
    });
  });

  if (typeof threshold === "number") {
    const best = store.accounts[eligible[0]];
    if (getMinRemaining(best.rateLimits) < threshold) return null;
  }

  return eligible[0];
}

function shuffled<T>(input: T[]): T[] {
  const a = [...input];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

interface AccountHealth {
  alias: string;
  isHealthy: boolean;
  isInProbation: boolean;
  recentFailures: number;
  priority: number;
}

function evaluateAccountHealth(acc: AccountCredentials, now: number): AccountHealth {
  const wasRateLimited: boolean = !!(
    acc.rateLimitedUntil && acc.rateLimitedUntil > now - HEALTH_HYSTERESIS_MS
  );
  const wasModelUnsupported: boolean = !!(
    acc.modelUnsupportedUntil && acc.modelUnsupportedUntil > now - HEALTH_HYSTERESIS_MS
  );
  const wasWorkspaceDeactivated: boolean = !!(
    acc.workspaceDeactivatedUntil && acc.workspaceDeactivatedUntil > now - HEALTH_HYSTERESIS_MS
  );

  // Phase D: Check if account is disabled
  const isDisabled: boolean = acc.enabled === false;

  const currentlyBlocked: boolean =
    !!(acc.rateLimitedUntil && acc.rateLimitedUntil > now) ||
    !!(acc.modelUnsupportedUntil && acc.modelUnsupportedUntil > now) ||
    !!(acc.workspaceDeactivatedUntil && acc.workspaceDeactivatedUntil > now) ||
    !!acc.authInvalid ||
    isDisabled; // Phase D: Exclude disabled accounts

  const isInProbation: boolean =
    !currentlyBlocked && (wasRateLimited || wasModelUnsupported || wasWorkspaceDeactivated);

  let recentFailures = 0;
  if (acc.lastLimitErrorAt && acc.lastLimitErrorAt > now - RECENT_FAILURE_WINDOW_MS) {
    recentFailures++;
  }
  if (acc.authInvalidatedAt && acc.authInvalidatedAt > now - RECENT_FAILURE_WINDOW_MS) {
    recentFailures++;
  }

  let priority = 100;
  if (isInProbation) priority -= 30;
  if (recentFailures > 0) priority -= recentFailures * 10;
  if (acc.usageCount === 0) priority -= 5;
  if (currentlyBlocked) priority = 0;
  // Phase D: Disabled accounts get lowest priority
  if (isDisabled) priority = -1;

  return {
    alias: acc.alias,
    isHealthy: !currentlyBlocked && !acc.authInvalid && !isDisabled,
    isInProbation,
    recentFailures,
    priority,
  };
}

export async function getNextAccount(
  config: typeof DEFAULT_CONFIG,
  options?: { excludeAliases?: Iterable<string> },
): Promise<RotationResult | null> {
  // Phase E: Check and auto-clear expired/invalid force state
  const autoClear = checkAndAutoClearForce();
  if (autoClear.wasCleared) {
    console.log(`[enhancer] Force mode auto-cleared: ${autoClear.reason}`);
  }

  // Phase E: Check if force mode is active
  const forceActive = isForceActive();
  const forceState = getForceState();

  let store = loadStore();
  const aliases = Object.keys(store.accounts);

  if (aliases.length === 0) {
    const diag = getStoreDiagnostics();
    const extra = diag.error ? ` (${diag.error})` : "";
    console.error(`[enhancer] No accounts configured. Run: opencode-enhancer add <alias>${extra}`);
    if (isDebugEnabled()) {
      console.error(`[enhancer] store file: ${diag.storeFile}`);
    }
    return null;
  }

  const now = Date.now();
  const excludedAliases = new Set(options?.excludeAliases || []);

  // Phase E: If force mode is active, never fall back to another alias.
  if (forceActive && forceState.forcedAlias) {
    const forcedAlias = forceState.forcedAlias;
    const forcedAccount = store.accounts[forcedAlias];

    if (forcedAccount) {
      const health = evaluateAccountHealth(forcedAccount, now);

      if (health.isHealthy) {
        const token = await ensureValidToken(forcedAlias);
        if (token) {
          store = updateAccount(forcedAlias, {
            usageCount: (forcedAccount.usageCount || 0) + 1,
            lastUsed: now,
            limitError: undefined,
          });

          store.activeAlias = forcedAlias;
          store.lastRotation = now;
          saveStore(store);

          console.log(`[enhancer] Force mode: using ${forcedAlias}`);
          return {
            account: store.accounts[forcedAlias],
            token,
            forceState: {
              active: true,
              alias: forcedAlias,
              remainingMs: forceState.forcedUntil ? forceState.forcedUntil - now : 0,
            },
          };
        } else {
          console.warn(
            `[enhancer] Force mode: ${forcedAlias} token unavailable; refusing fallback`,
          );
          return null;
        }
      } else {
        console.warn(`[enhancer] Force mode: ${forcedAlias} currently blocked; refusing fallback`);
        return null;
      }
    } else {
      // Forced account no longer exists - clear force and proceed normally.
      console.warn(`[enhancer] Force mode: ${forcedAlias} not found, clearing force`);
      clearForce();
    }
  }

  const healthMap = new Map<string, AccountHealth>();
  for (const alias of aliases) {
    const acc = store.accounts[alias];
    healthMap.set(alias, evaluateAccountHealth(acc, now));
  }

  const availableAliases = aliases.filter((alias) => {
    if (excludedAliases.has(alias)) return false;
    const health = healthMap.get(alias);
    return health?.isHealthy === true;
  });

  if (availableAliases.length === 0) {
    console.warn("[enhancer] No available accounts (rate-limited or invalidated).");
    return null;
  }

  const tokenFailureCooldownMs = (() => {
    const raw = readEnv(
      "OPENCODE_ENHANCER_TOKEN_FAILURE_COOLDOWN_MS",
      "OPENCODE_MULTI_AUTH_TOKEN_FAILURE_COOLDOWN_MS",
    );
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return 60_000;
  })();

  const runtimeSettings = getRuntimeSettings();
  const rotationStrategy = runtimeSettings.settings.rotationStrategy || config.rotationStrategy;

  const buildCandidates = (): { aliases: string[]; nextIndex?: (selected: string) => number } => {
    switch (rotationStrategy) {
      case "least-used": {
        const sorted = [...availableAliases].sort((a, b) => {
          const aa = store.accounts[a];
          const bb = store.accounts[b];
          const healthA = healthMap.get(a);
          const healthB = healthMap.get(b);

          const priorityDiff = (healthB?.priority || 0) - (healthA?.priority || 0);
          if (priorityDiff !== 0) return priorityDiff;

          const usageDiff = (aa?.usageCount || 0) - (bb?.usageCount || 0);
          if (usageDiff !== 0) return usageDiff;
          const lastDiff = (aa?.lastUsed || 0) - (bb?.lastUsed || 0);
          if (lastDiff !== 0) return lastDiff;
          return a.localeCompare(b);
        });
        return { aliases: sorted };
      }
      case "random": {
        const sorted = [...availableAliases].sort((a, b) => {
          const healthA = healthMap.get(a);
          const healthB = healthMap.get(b);
          return (healthB?.priority || 0) - (healthA?.priority || 0);
        });
        const topPriority = sorted.slice(0, Math.ceil(sorted.length / 2));
        return { aliases: shuffled(topPriority.length > 0 ? topPriority : sorted) };
      }
      case "weighted-round-robin": {
        const weights = runtimeSettings.settings.accountWeights;

        // Filter to healthy accounts with weights
        const weightedAliases = availableAliases.filter((alias) => (weights[alias] || 0) > 0);

        if (weightedAliases.length === 0) {
          // Fallback to round-robin if no weights defined
          const sorted = [...availableAliases].sort((a, b) => {
            const healthA = healthMap.get(a);
            const healthB = healthMap.get(b);
            return (healthB?.priority || 0) - (healthA?.priority || 0);
          });
          const start = store.rotationIndex % sorted.length;
          const rr = sorted.map((_, i) => sorted[(start + i) % sorted.length]);
          const nextIndex = (selected: string): number => {
            const idx = sorted.indexOf(selected);
            if (idx < 0) return store.rotationIndex;
            return (idx + 1) % sorted.length;
          };
          return { aliases: rr, nextIndex };
        }

        // Use weighted selection
        const selected = calculateWeightedSelection(weightedAliases, weights);
        if (!selected) {
          // Fallback to round-robin
          const sorted = [...availableAliases].sort((a, b) => {
            const healthA = healthMap.get(a);
            const healthB = healthMap.get(b);
            return (healthB?.priority || 0) - (healthA?.priority || 0);
          });
          const start = store.rotationIndex % sorted.length;
          const rr = sorted.map((_, i) => sorted[(start + i) % sorted.length]);
          return { aliases: rr };
        }

        return { aliases: [selected] };
      }
      case "usage-priority": {
        // Always pick the account with the most remaining usage,
        // prioritizing weekly remaining before 5h remaining.
        const sorted = [...availableAliases].sort((a, b) => {
          return compareAccountsByUsagePriority(store.accounts[a], store.accounts[b], {
            healthPriorityA: healthMap.get(a)?.priority,
            healthPriorityB: healthMap.get(b)?.priority,
            now,
          });
        });

        // Sticky preference: keep the active account unless it's genuinely
        // running low on capacity. This prevents unnecessary switches when
        // the active account still has plenty of usage remaining.
        const active = store.activeAlias;
        if (active && sorted.length > 1 && sorted[0] !== active && sorted.includes(active)) {
          const activeAccount = store.accounts[active];
          const activeMinRemaining = getMinRemaining(activeAccount.rateLimits);
          const configuredThreshold = Number.isFinite(config.autoSwitchThreshold)
            ? Math.max(0, Math.min(100, config.autoSwitchThreshold))
            : AUTO_SWITCH_THRESHOLD_DEFAULT;
          const switchFloor = 100 - configuredThreshold;
          if (activeMinRemaining > switchFloor) {
            const idx = sorted.indexOf(active);
            sorted.splice(idx, 1);
            sorted.unshift(active);
          }
        }

        return { aliases: sorted };
      }
      case "round-robin":
      default: {
        const sorted = [...availableAliases].sort((a, b) => {
          const healthA = healthMap.get(a);
          const healthB = healthMap.get(b);
          return (healthB?.priority || 0) - (healthA?.priority || 0);
        });
        const start = store.rotationIndex % sorted.length;
        const rr = sorted.map((_, i) => sorted[(start + i) % sorted.length]);
        const nextIndex = (selected: string): number => {
          const idx = sorted.indexOf(selected);
          if (idx < 0) return store.rotationIndex;
          return (idx + 1) % sorted.length;
        };
        return { aliases: rr, nextIndex };
      }
    }
  };

  const { aliases: candidates, nextIndex } = buildCandidates();

  for (const candidate of candidates) {
    const token = await ensureValidToken(candidate);
    if (!token) {
      store = updateAccount(candidate, {
        rateLimitedUntil: now + tokenFailureCooldownMs,
        limitError: "[enhancer] Token unavailable (refresh failed?)",
        lastLimitErrorAt: now,
      });
      continue;
    }

    store = updateAccount(candidate, {
      usageCount: (store.accounts[candidate]?.usageCount || 0) + 1,
      lastUsed: now,
      limitError: undefined,
    });

    store.activeAlias = candidate;
    store.lastRotation = now;
    if (nextIndex) {
      store.rotationIndex = nextIndex(candidate);
    }
    saveStore(store);

    const currentForceState = getForceState();
    return {
      account: store.accounts[candidate],
      token,
      forceState: {
        active: isForceActive(),
        alias: currentForceState.forcedAlias,
        remainingMs: currentForceState.forcedUntil ? currentForceState.forcedUntil - now : 0,
      },
    };
  }

  console.error("[enhancer] No available accounts (token refresh failed on all candidates).");
  return null;
}

export function markRateLimited(alias: string, rateLimitedUntil: number): void {
  const now = Date.now();
  const safeUntil = Math.max(rateLimitedUntil, now + 1000);
  const seconds = Math.max(1, Math.ceil((safeUntil - now) / 1000));
  updateAccount(alias, {
    rateLimitedUntil: safeUntil,
  });
  console.warn(`[enhancer] Account ${alias} marked rate-limited for ${seconds}s`);
}

export function clearRateLimit(alias: string): void {
  updateAccount(alias, {
    rateLimitedUntil: undefined,
  });
}

export function markModelUnsupported(
  alias: string,
  cooldownMs: number,
  info?: { model?: string; error?: string },
): void {
  updateAccount(alias, {
    modelUnsupportedUntil: Date.now() + cooldownMs,
    modelUnsupportedAt: Date.now(),
    modelUnsupportedModel: info?.model,
    modelUnsupportedError: info?.error,
  });
  const extra = info?.model ? ` (model=${info.model})` : "";
  console.warn(
    `[enhancer] Account ${alias} marked model-unsupported for ${cooldownMs / 1000}s${extra}`,
  );
}

export function clearModelUnsupported(alias: string): void {
  updateAccount(alias, {
    modelUnsupportedUntil: undefined,
    modelUnsupportedAt: undefined,
    modelUnsupportedModel: undefined,
    modelUnsupportedError: undefined,
  });
}

export function markWorkspaceDeactivated(
  alias: string,
  cooldownMs: number,
  info?: { error?: string },
): void {
  updateAccount(alias, {
    workspaceDeactivatedUntil: Date.now() + cooldownMs,
    workspaceDeactivatedAt: Date.now(),
    workspaceDeactivatedError: info?.error,
  });
  console.warn(
    `[enhancer] Account ${alias} marked workspace-deactivated for ${cooldownMs / 1000}s`,
  );
}

export function clearWorkspaceDeactivated(alias: string): void {
  updateAccount(alias, {
    workspaceDeactivatedUntil: undefined,
    workspaceDeactivatedAt: undefined,
    workspaceDeactivatedError: undefined,
  });
}

export function markAuthInvalid(alias: string): void {
  updateAccount(alias, {
    authInvalid: true,
    authInvalidatedAt: Date.now(),
  });
  console.warn(`[enhancer] Account ${alias} marked invalidated`);
}

export function clearAuthInvalid(alias: string): void {
  updateAccount(alias, {
    authInvalid: false,
    authInvalidatedAt: undefined,
  });
}
