// Account credentials stored locally
export interface AccountCredentials {
  alias: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accountId?: string;
  accountUserId?: string;
  userId?: string;
  planType?: string;
  expiresAt: number; // Unix timestamp
  email?: string;
  name?: string; // Full name from OpenAI userinfo
  lastRefresh?: string;
  lastSeenAt?: number;
  lastActiveUntil?: number;
  lastUsed?: number;
  usageCount: number;
  rateLimitedUntil?: number; // If hit rate limit, when it resets
  // Some accounts don't have access to a given Codex model yet (staged rollout).
  // We temporarily skip them instead of hard-invalidating the account.
  modelUnsupportedUntil?: number;
  modelUnsupportedAt?: number;
  modelUnsupportedModel?: string;
  modelUnsupportedError?: string;
  // Some ChatGPT accounts can be in a deactivated workspace state (402 Payment Required,
  // detail.code = "deactivated_workspace"). Treat this as a temporary block and rotate.
  workspaceDeactivatedUntil?: number;
  workspaceDeactivatedAt?: number;
  workspaceDeactivatedError?: string;
  authInvalid?: boolean;
  authInvalidatedAt?: number;
  // Phase D: Account availability fields
  enabled?: boolean; // Defaults to true if not set
  disabledAt?: number;
  disabledBy?: string;
  disableReason?: string;
  rateLimits?: AccountRateLimits;
  rateLimitHistory?: RateLimitHistoryEntry[];
  limitStatus?: LimitStatus;
  limitError?: string;
  lastLimitProbeAt?: number;
  lastLimitErrorAt?: number;
  // Phase C: Freshness/confidence state
  limitsConfidence?: LimitsConfidence;
  tags?: string[];
  notes?: string;
  source?: "opencode" | "codex";
}

export interface RateLimitWindow {
  limit?: number;
  remaining?: number;
  resetAt?: number;
  updatedAt?: number;
}

export interface AccountRateLimits {
  fiveHour?: RateLimitWindow;
  weekly?: RateLimitWindow;
}

export interface RateLimitSnapshot {
  remaining?: number;
  limit?: number;
  resetAt?: number;
}

export interface RateLimitHistoryEntry {
  at: number;
  fiveHour?: RateLimitSnapshot;
  weekly?: RateLimitSnapshot;
}

export type LimitStatus = "idle" | "queued" | "running" | "success" | "error" | "stopped";

// Phase C: Freshness/confidence state for limits data
export type LimitsConfidence = "fresh" | "stale" | "error" | "unknown";

// Phase C: Calculate limits confidence based on probe timestamps
export function calculateLimitsConfidence(
  lastProbeAt: number | undefined,
  lastErrorAt: number | undefined,
  limitStatus: LimitStatus | undefined,
): LimitsConfidence {
  const now = Date.now();
  const FRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
  const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes

  // If we have an error more recent than last success, show error
  if (lastErrorAt && (!lastProbeAt || lastErrorAt > lastProbeAt)) {
    // If we have some successful data, show stale with error
    if (lastProbeAt && now - lastProbeAt < STALE_THRESHOLD_MS) {
      return "error";
    }
  }

  // No successful probe ever
  if (!lastProbeAt) {
    return "unknown";
  }

  const ageMs = now - lastProbeAt;

  if (ageMs < FRESH_THRESHOLD_MS) {
    return "fresh";
  } else if (ageMs < STALE_THRESHOLD_MS) {
    return "stale";
  } else {
    // Data is too old, treat as unknown
    return "unknown";
  }
}

// Local store for all accounts
export interface AccountStore {
  version?: number; // Store version for migrations
  accounts: Record<string, AccountCredentials>;
  activeAlias: string | null;
  rotationIndex: number;
  lastRotation: number;
  // Phase E: Force mode fields
  forcedAlias?: string | null;
  forcedUntil?: number | null;
  previousRotationStrategy?: string | null;
  forcedBy?: string | null;
  rotationStrategy?:
    | "round-robin"
    | "least-used"
    | "random"
    | "weighted-round-robin"
    | "usage-priority";
  // Phase F: Settings
  settings?: Partial<RotationSettings>;
}

// OpenAI model info
export interface OpenAIModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

// Plugin config
export type RotationStrategy =
  | "round-robin"
  | "least-used"
  | "random"
  | "weighted-round-robin"
  | "usage-priority";

const VALID_ROTATION_STRATEGIES = new Set<RotationStrategy>([
  "round-robin",
  "least-used",
  "random",
  "weighted-round-robin",
  "usage-priority",
]);

export const AUTO_SWITCH_THRESHOLD_DEFAULT = 90;

export interface PluginConfig {
  rotationStrategy: RotationStrategy;
  autoRefreshTokens: boolean;
  rateLimitCooldownMs: number; // How long to skip rate-limited accounts
  modelUnsupportedCooldownMs: number; // How long to skip accounts that don't support the requested model
  workspaceDeactivatedCooldownMs: number; // How long to skip accounts with deactivated workspaces
  modelFilter: RegExp; // Which models to expose
  autoSwitchOnLowUsage: boolean; // Auto-switch to account with highest usage when current account is low
  autoSwitchThreshold: number; // Used % threshold at/above which auto-switch triggers (weekly first, then 5h) (0-100)
}

// OpenCode provider model definition
export interface ProviderModel {
  name: string;
  limit: {
    context: number;
    output: number;
  };
  modalities: {
    input: string[];
    output: string[];
  };
  options: {
    reasoningEffort: string;
    reasoningSummary: string;
    textVerbosity: string;
    include: string[];
    store: boolean;
    service_tier?: string;
  };
}

export const DEFAULT_CONFIG: PluginConfig = {
  rotationStrategy: "usage-priority",
  autoRefreshTokens: true,
  rateLimitCooldownMs: 5 * 60 * 1000,
  modelUnsupportedCooldownMs: 30 * 60 * 1000,
  workspaceDeactivatedCooldownMs: 30 * 60 * 1000,
  modelFilter: /^gpt-5/,
  autoSwitchOnLowUsage: true,
  autoSwitchThreshold: AUTO_SWITCH_THRESHOLD_DEFAULT,
};

// Phase F: Settings model for weighted rotation and thresholds
export interface RotationSettings {
  // Rotation strategy
  rotationStrategy:
    | "round-robin"
    | "least-used"
    | "random"
    | "weighted-round-robin"
    | "usage-priority";

  // Rate limit thresholds (0-100)
  criticalThreshold: number; // Account skipped below this (default: 10)
  lowThreshold: number; // Warning threshold (default: 30)

  // Account weights for weighted rotation (0-1, sum should be 1)
  accountWeights: Record<string, number>;

  // Phase G: Feature flags
  featureFlags?: FeatureFlags;

  // Native notification toggles
  notifications?: NotificationSettings;

  // Last updated
  updatedAt?: number;
  updatedBy?: string;
}

// Phase G: Feature flags for non-core functionality
export interface FeatureFlags {
  // Antigravity integration (default: false)
  antigravityEnabled: boolean;
  // Auto-switch to better account when current is low on usage (default: true)
  autoSwitch: boolean;
}

export interface NotificationSettings {
  permissionRequest: boolean;
  taskComplete: boolean;
  error: boolean;
  question: boolean;
  whenTerminalActive: boolean;
}

// Phase G: Default feature flags
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  antigravityEnabled: false,
  autoSwitch: true,
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  permissionRequest: true,
  taskComplete: true,
  error: true,
  question: true,
  whenTerminalActive: false,
};

// Phase F: Weighted rotation presets
export type WeightPreset = "balanced" | "conservative" | "aggressive" | "usage-first" | "custom";

export interface WeightedPresetConfig {
  name: WeightPreset;
  description: string;
  defaultWeights: Record<string, number>;
  thresholds: {
    critical: number;
    low: number;
  };
}

// Phase F: Default settings
export const DEFAULT_ROTATION_SETTINGS: RotationSettings = {
  rotationStrategy: "usage-priority",
  criticalThreshold: 10,
  lowThreshold: 30,
  accountWeights: {},
  featureFlags: { ...DEFAULT_FEATURE_FLAGS },
  notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeRotationSettings(input: unknown): Partial<RotationSettings> | undefined {
  if (!isRecord(input)) return undefined;

  const settings: Partial<RotationSettings> = {};

  if (
    typeof input.rotationStrategy === "string" &&
    VALID_ROTATION_STRATEGIES.has(input.rotationStrategy as RotationStrategy)
  ) {
    settings.rotationStrategy = input.rotationStrategy as RotationStrategy;
  }

  if (typeof input.criticalThreshold === "number" && Number.isFinite(input.criticalThreshold)) {
    settings.criticalThreshold = input.criticalThreshold;
  }

  if (typeof input.lowThreshold === "number" && Number.isFinite(input.lowThreshold)) {
    settings.lowThreshold = input.lowThreshold;
  }

  if (isRecord(input.accountWeights)) {
    const accountWeights = Object.fromEntries(
      Object.entries(input.accountWeights).filter(
        ([, value]) => typeof value === "number" && Number.isFinite(value),
      ),
    ) as Record<string, number>;
    settings.accountWeights = accountWeights;
  }

  if (isRecord(input.featureFlags)) {
    const featureFlags: FeatureFlags = {
      ...DEFAULT_FEATURE_FLAGS,
      ...(typeof input.featureFlags.antigravityEnabled === "boolean"
        ? { antigravityEnabled: input.featureFlags.antigravityEnabled }
        : {}),
      ...(typeof input.featureFlags.autoSwitch === "boolean"
        ? { autoSwitch: input.featureFlags.autoSwitch }
        : {}),
    };
    settings.featureFlags = featureFlags;
  }

  if (isRecord(input.notifications)) {
    const notifications: NotificationSettings = {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      ...(typeof input.notifications.permissionRequest === "boolean"
        ? { permissionRequest: input.notifications.permissionRequest }
        : {}),
      ...(typeof input.notifications.taskComplete === "boolean"
        ? { taskComplete: input.notifications.taskComplete }
        : {}),
      ...(typeof input.notifications.error === "boolean"
        ? { error: input.notifications.error }
        : {}),
      ...(typeof input.notifications.question === "boolean"
        ? { question: input.notifications.question }
        : {}),
      ...(typeof input.notifications.whenTerminalActive === "boolean"
        ? { whenTerminalActive: input.notifications.whenTerminalActive }
        : {}),
    };
    settings.notifications = notifications;
  }

  if (typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt)) {
    settings.updatedAt = input.updatedAt;
  }

  if (typeof input.updatedBy === "string") {
    settings.updatedBy = input.updatedBy;
  }

  return settings;
}

// Phase F: Preset configurations
export const WEIGHTED_PRESETS: Record<WeightPreset, WeightedPresetConfig> = {
  balanced: {
    name: "balanced",
    description: "Equal distribution across all accounts",
    defaultWeights: {}, // Calculated dynamically as 1/n
    thresholds: { critical: 10, low: 30 },
  },
  conservative: {
    name: "conservative",
    description: "Prefer accounts with higher remaining limits",
    defaultWeights: {}, // Calculated based on limit health
    thresholds: { critical: 20, low: 40 },
  },
  aggressive: {
    name: "aggressive",
    description: "Maximize throughput, accept higher risk",
    defaultWeights: {},
    thresholds: { critical: 5, low: 20 },
  },
  "usage-first": {
    name: "usage-first",
    description: "Always pick the account with the most remaining usage",
    defaultWeights: {},
    thresholds: { critical: 10, low: 30 },
  },
  custom: {
    name: "custom",
    description: "User-defined weights and thresholds",
    defaultWeights: {},
    thresholds: { critical: 10, low: 30 },
  },
};

// Phase F: Settings validation
export interface SettingsValidationError {
  field: string;
  message: string;
  constraint: string;
}

export function validateSettings(settings: Partial<RotationSettings>): SettingsValidationError[] {
  const errors: SettingsValidationError[] = [];

  // Validate thresholds are in 0-100 range
  if (settings.criticalThreshold !== undefined) {
    if (
      typeof settings.criticalThreshold !== "number" ||
      Number.isNaN(settings.criticalThreshold)
    ) {
      errors.push({
        field: "criticalThreshold",
        message: "Critical threshold must be a number",
        constraint: "typeof criticalThreshold === number",
      });
    } else if (settings.criticalThreshold < 0 || settings.criticalThreshold > 100) {
      errors.push({
        field: "criticalThreshold",
        message: "Critical threshold must be between 0 and 100",
        constraint: "0 <= criticalThreshold <= 100",
      });
    }
  }

  if (settings.lowThreshold !== undefined) {
    if (typeof settings.lowThreshold !== "number" || Number.isNaN(settings.lowThreshold)) {
      errors.push({
        field: "lowThreshold",
        message: "Low threshold must be a number",
        constraint: "typeof lowThreshold === number",
      });
    } else if (settings.lowThreshold < 0 || settings.lowThreshold > 100) {
      errors.push({
        field: "lowThreshold",
        message: "Low threshold must be between 0 and 100",
        constraint: "0 <= lowThreshold <= 100",
      });
    }
  }

  // Validate critical < low
  if (typeof settings.criticalThreshold === "number" && typeof settings.lowThreshold === "number") {
    if (settings.criticalThreshold >= settings.lowThreshold) {
      errors.push({
        field: "thresholds",
        message: "Critical threshold must be less than low threshold",
        constraint: "criticalThreshold < lowThreshold",
      });
    }
  }

  // Validate weights are in (0, 1] range
  if (settings.accountWeights) {
    for (const [alias, weight] of Object.entries(settings.accountWeights)) {
      if (typeof weight !== "number" || Number.isNaN(weight) || weight <= 0 || weight > 1) {
        errors.push({
          field: `accountWeights.${alias}`,
          message: `Weight for ${alias} must be between 0 and 1`,
          constraint: "0 < weight <= 1",
        });
      }
    }

    // Validate weights sum to approximately 1
    const totalWeight = Object.values(settings.accountWeights).reduce((sum, w) => sum + w, 0);
    if (totalWeight > 0 && Math.abs(totalWeight - 1) > 0.01) {
      errors.push({
        field: "accountWeights",
        message: "Total weights must sum to 1.0",
        constraint: "sum(weights) ≈ 1.0",
      });
    }
  }

  if (settings.notifications) {
    const entries = Object.entries(settings.notifications) as Array<
      [keyof NotificationSettings, unknown]
    >;
    for (const [key, value] of entries) {
      if (typeof value !== "boolean") {
        errors.push({
          field: `notifications.${key}`,
          message: `${key} notification toggle must be true or false`,
          constraint: "typeof notifications.<key> === boolean",
        });
      }
    }
  }

  return errors;
}
