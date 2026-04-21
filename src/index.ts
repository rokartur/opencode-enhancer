import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncAuthFromOpenCode } from "./auth-sync.js";
import { createAuthorizationFlow, loginAccount, ensureValidToken, refreshToken } from "./auth.js";
import {
  extractRateLimitUpdate,
  getBlockingRateLimitResetAt,
  mergeRateLimits,
  parseRateLimitResetFromError,
  parseRetryAfterHeader,
} from "./rate-limits.js";
import {
  getNextAccount,
  markAuthInvalid,
  markModelUnsupported,
  markRateLimited,
  markWorkspaceDeactivated,
  selectBestAvailableAccount,
} from "./rotation.js";
import { compareAccountsByUsagePriority, getUsagePrioritySnapshot } from "./account-ranking.js";
import { getDefaultModels } from "./models.js";
import { getForceState, isForceActive } from "./force-mode.js";
import { getRuntimeSettings, isFeatureEnabled, isNotificationEnabled } from "./settings.js";
import {
  listAccounts,
  updateAccount,
  loadStore,
  promoteSelectedAccount,
  setActiveAlias,
} from "./store.js";
import {
  DEFAULT_CONFIG,
  type AccountCredentials,
  type AccountRateLimits,
  type PluginConfig,
} from "./types.js";
import { Errors, type DeterministicError } from "./errors.js";
import { decodeJwtPayload } from "./jwt.js";
import {
  PROVIDER_ID,
  CODEX_BASE_URL,
  REDIRECT_PORT,
  REDIRECT_URI,
  URL_PATHS,
  OPENAI_HEADERS,
  OPENAI_HEADER_VALUES,
  JWT_CLAIM_PATH,
  TIMEOUTS,
} from "./constants.js";

let pluginConfig: PluginConfig = { ...DEFAULT_CONFIG };

function normalizePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

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

function debugLog(message: string): void {
  if (!isDebugEnabled()) return;
  console.log(`[enhancer] ${message}`);
}

function configure(config: Partial<PluginConfig>): void {
  pluginConfig = { ...pluginConfig, ...config };
}

function formatUsageWindow(
  label: string,
  window: AccountRateLimits["fiveHour"],
): string | undefined {
  if (!window || typeof window.remaining !== "number") return undefined;
  if (window.limit === 100) return `${label}: ${window.remaining}%`;
  if (typeof window.limit === "number") return `${label}: ${window.remaining}/${window.limit}`;
  return `${label}: ${window.remaining}`;
}

function formatAccountUsageSummary(rateLimits?: AccountRateLimits): string {
  const parts = [
    formatUsageWindow("5h", rateLimits?.fiveHour),
    formatUsageWindow("wk", rateLimits?.weekly),
  ].filter(Boolean);
  return parts.join(" · ");
}

function buildAccountSelectOption(account: AccountCredentials): {
  label: string;
  value: string;
  hint: string;
} {
  const label = account.email?.trim() || account.alias;
  const now = Date.now();
  const parts: string[] = [];

  if (account.authInvalid) {
    parts.push("invalid");
  } else if (account.expiresAt && account.expiresAt < now) {
    parts.push("expired");
  }

  const usageHint = formatAccountUsageSummary(account.rateLimits);
  if (usageHint) parts.push(usageHint);

  return {
    label,
    value: account.alias,
    hint: parts.join(" · "),
  };
}

function extractRequestUrl(input: Request | string | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function rewriteUrlForCodex(url: string): string {
  return url.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES);
}

function extractPathAndSearch(url: string): string {
  // OpenCode sometimes passes relative paths (e.g. "/chat/completions") or even
  // malformed strings when provider base_url is missing (e.g. "undefined/...").
  // We only need the path+query and then we force the ChatGPT backend base URL.
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    // best-effort fallback
  }

  const trimmed = String(url || "").trim();
  if (trimmed.startsWith("/")) return trimmed;
  const firstSlash = trimmed.indexOf("/");
  if (firstSlash >= 0) return trimmed.slice(firstSlash);
  return trimmed;
}

function toCodexBackendUrl(originalUrl: string): string {
  const pathAndSearch = extractPathAndSearch(originalUrl);

  // Map OpenAI v1 endpoints to ChatGPT Codex endpoints.
  let mapped = pathAndSearch;
  if (mapped.includes(URL_PATHS.RESPONSES)) {
    mapped = mapped.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES);
  } else if (mapped.includes("/chat/completions")) {
    mapped = mapped.replace("/chat/completions", "/codex/chat/completions");
  }

  return new URL(mapped, CODEX_BASE_URL).toString();
}

function filterInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input
    .filter((item) => item?.type !== "item_reference")
    .map((item) => {
      if (item && typeof item === "object" && "id" in item) {
        const { id, ...rest } = item as Record<string, unknown>;
        return rest;
      }
      return item;
    });
}

function normalizeModel(model: string | undefined): string {
  if (!model) return "gpt-5.1";

  const modelId = model.includes("/") ? model.split("/").pop()! : model;
  const baseModel = modelId.replace(/-(?:fast|none|minimal|low|medium|high|xhigh)$/, "");

  // OpenCode may lag behind the latest ChatGPT Codex model allowlist. Route known
  // older Codex selections to the latest backend model when enabled.
  // Codex model on the ChatGPT backend for users who want the newest model without
  // waiting for upstream registry updates.
  const preferLatestRaw = readEnv(
    "OPENCODE_ENHANCER_PREFER_CODEX_LATEST",
    "OPENCODE_MULTI_AUTH_PREFER_CODEX_LATEST",
  );
  const preferLatest = preferLatestRaw === "1" || preferLatestRaw === "true";

  if (
    preferLatest &&
    (baseModel === "gpt-5.3-codex" || baseModel === "gpt-5.2-codex" || baseModel === "gpt-5-codex")
  ) {
    const latestModel = (
      readEnv("OPENCODE_ENHANCER_CODEX_LATEST_MODEL", "OPENCODE_MULTI_AUTH_CODEX_LATEST_MODEL") ||
      "gpt-5.4"
    ).trim();

    if (isDebugEnabled()) {
      console.log(`[enhancer] model map: ${baseModel} -> ${latestModel}`);
    }

    return latestModel;
  }

  return baseModel;
}

function ensureContentType(headers: Headers): Headers {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "text/event-stream; charset=utf-8");
  }
  return responseHeaders;
}

function extractErrorMessage(payload: any, fallbackText: string = ""): string {
  if (!payload || typeof payload !== "object") {
    return fallbackText;
  }

  const detailMessage =
    typeof payload?.detail?.message === "string"
      ? payload.detail.message
      : typeof payload?.detail === "string"
        ? payload.detail
        : "";

  const errorMessage = typeof payload?.error?.message === "string" ? payload.error.message : "";

  const topLevelMessage = typeof payload?.message === "string" ? payload.message : "";

  return detailMessage || errorMessage || topLevelMessage || fallbackText;
}

function resolveRateLimitedUntil(
  rateLimits: AccountRateLimits | undefined,
  headers: Headers,
  errorText: string,
  fallbackCooldownMs: number,
  now: number = Date.now(),
): number {
  const retryAfterUntil = parseRetryAfterHeader(headers.get("retry-after"), now) || 0;
  const windowResetUntil = getBlockingRateLimitResetAt(rateLimits, now) || 0;
  const messageResetUntil = parseRateLimitResetFromError(errorText, now) || 0;
  const fallbackUntil = now + fallbackCooldownMs;

  return Math.max(fallbackUntil, retryAfterUntil, windowResetUntil, messageResetUntil);
}

function parseSseStream(sseText: string): unknown | null {
  const lines = sseText.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    try {
      const data = JSON.parse(line.substring(6)) as { type?: string; response?: unknown };
      if (data?.type === "response.done" || data?.type === "response.completed") {
        return data.response;
      }
    } catch {
      // ignore malformed chunks
    }
  }
  return null;
}

async function convertSseToJson(response: Response, headers: Headers): Promise<Response> {
  if (!response.body) {
    throw new Error("[enhancer] Response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fullText += decoder.decode(value, { stream: true });
  }

  const finalResponse = parseSseStream(fullText);
  if (!finalResponse) {
    return new Response(fullText, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const jsonHeaders = new Headers(headers);
  jsonHeaders.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(finalResponse), {
    status: response.status,
    statusText: response.statusText,
    headers: jsonHeaders,
  });
}

/**
 * Multi-account OAuth plugin for OpenCode
 *
 * Rotates between multiple ChatGPT Plus/Pro accounts for rate limit resilience.
 */
const MultiAuthPlugin: Plugin = async ({
  client,
  $,
  serverUrl,
  project,
  directory,
}: PluginInput) => {
  debugLog("plugin initialized");
  const terminalNotifierPath = (() => {
    const candidates = ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {
        // ignore
      }
    }
    return null;
  })();

  const notifyEnabledRaw = readEnv("OPENCODE_ENHANCER_NOTIFY", "OPENCODE_MULTI_AUTH_NOTIFY");
  const notifyEnabled = notifyEnabledRaw !== "0" && notifyEnabledRaw !== "false";
  type NotifyBackend = "auto" | "terminal" | "system";
  const notifyBackend: NotifyBackend = (() => {
    const raw = (
      readEnv("OPENCODE_ENHANCER_NOTIFY_BACKEND", "OPENCODE_MULTI_AUTH_NOTIFY_BACKEND") || "auto"
    )
      .trim()
      .toLowerCase();

    if (raw === "terminal" || raw === "system") return raw;
    return "auto";
  })();
  const notifySound = (
    readEnv("OPENCODE_ENHANCER_NOTIFY_SOUND", "OPENCODE_MULTI_AUTH_NOTIFY_SOUND") ||
    "/System/Library/Sounds/Glass.aiff"
  ).trim();
  const notifyWhenTerminalActive = isNotificationEnabled("whenTerminalActive", true);

  const lastStatusBySession = new Map<string, string>();
  const lastNotifiedAtByKey = new Map<string, number>();
  const lastRetryAttemptBySession = new Map<string, number>();

  const sanitizeOscText = (value: string): string => {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const truncateText = (value: string, maxLength: number): string => {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  };

  const formatOsc9Message = (title: string, body: string): string => {
    const safeTitle = sanitizeOscText(title);
    const safeBody = sanitizeOscText(body);
    const combined = [safeTitle, safeBody].filter(Boolean).join(" — ");
    const prefixed = /^\d+;/.test(combined) ? `OpenCode ${combined}` : combined;
    return truncateText(prefixed, 512);
  };

  type TerminalNotificationSupport = {
    supported: boolean;
    terminal?: "ghostty" | "iterm2" | "kitty" | "wezterm";
    reason?: string;
  };

  const TERMINAL_BUNDLE_IDS: Record<
    NonNullable<TerminalNotificationSupport["terminal"]>,
    string[]
  > = {
    ghostty: ["com.mitchellh.ghostty"],
    iterm2: ["com.googlecode.iterm2"],
    kitty: ["net.kovidgoyal.kitty"],
    wezterm: ["com.github.wez.wezterm"],
  };

  const getTerminalNotificationSupport = (): TerminalNotificationSupport => {
    if (process.env.ZELLIJ) {
      return { supported: false, reason: "zellij-not-supported" };
    }

    if (process.env.TMUX) {
      return { supported: false, reason: "tmux-requires-passthrough" };
    }

    if (process.env.STY) {
      return { supported: false, reason: "screen-not-supported" };
    }

    const termProgram = (process.env.TERM_PROGRAM || "").trim().toLowerCase();
    const term = (process.env.TERM || "").trim().toLowerCase();

    if (termProgram === "ghostty" || term.includes("ghostty")) {
      return { supported: true, terminal: "ghostty" };
    }

    if (termProgram === "iterm.app") {
      return { supported: true, terminal: "iterm2" };
    }

    if (process.env.KITTY_WINDOW_ID || term.includes("kitty")) {
      return { supported: true, terminal: "kitty" };
    }

    if (termProgram === "wezterm" || process.env.WEZTERM_PANE) {
      return { supported: true, terminal: "wezterm" };
    }

    return { supported: false, reason: "terminal-unsupported" };
  };

  const writeTerminalSequence = (sequence: string): boolean => {
    try {
      fs.appendFileSync("/dev/tty", sequence, { encoding: "utf8" });
      return true;
    } catch {
      // fall back to attached TTY streams below
    }

    for (const stream of [process.stderr, process.stdout]) {
      if (!stream?.isTTY || typeof stream.write !== "function") continue;
      try {
        stream.write(sequence);
        return true;
      } catch {
        // try next stream
      }
    }

    return false;
  };

  let cachedFrontmostBundleID: { value: string; expiresAt: number } | null = null;

  const getFrontmostMacBundleID = (): string => {
    if (process.platform !== "darwin") return "";

    const now = Date.now();
    if (cachedFrontmostBundleID && cachedFrontmostBundleID.expiresAt > now) {
      return cachedFrontmostBundleID.value;
    }

    try {
      const osascript = "/usr/bin/osascript";
      const script =
        'tell application "System Events" to get bundle identifier of first application process whose frontmost is true';
      const proc = spawnSync(osascript, ["-e", script], { encoding: "utf8" });
      const value = proc.status === 0 ? proc.stdout.trim() : "";
      cachedFrontmostBundleID = { value, expiresAt: now + 1000 };
      return value;
    } catch {
      cachedFrontmostBundleID = { value: "", expiresAt: now + 1000 };
      return "";
    }
  };

  const shouldMirrorTerminalNotificationToSystem = (
    terminalSupport: TerminalNotificationSupport,
  ): boolean => {
    if (notifyBackend !== "auto") return false;
    if (!notifyWhenTerminalActive) return false;
    if (process.platform !== "darwin") return false;
    if (!terminalSupport.supported || !terminalSupport.terminal) return false;

    const frontmostBundleID = getFrontmostMacBundleID();
    if (!frontmostBundleID) return false;

    return TERMINAL_BUNDLE_IDS[terminalSupport.terminal].includes(frontmostBundleID);
  };

  const notifyTerminal = (title: string, body: string): boolean => {
    if (!notifyEnabled) return false;

    const message = formatOsc9Message(title, body);
    if (!message) return false;

    return writeTerminalSequence(`\u001b]9;${message}\u001b\\`);
  };

  const escapeAppleScriptString = (value: string): string => {
    return String(value)
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\"')
      .replaceAll(String.fromCharCode(10), "\n");
  };

  let didWarnTerminalNotifier = false;

  const notifyMac = (title: string, message: string, clickUrl?: string): boolean => {
    if (!notifyEnabled) return false;
    if (process.platform !== "darwin") return false;

    const macOpenRaw = readEnv(
      "OPENCODE_ENHANCER_NOTIFY_MAC_OPEN",
      "OPENCODE_MULTI_AUTH_NOTIFY_MAC_OPEN",
    );
    const macOpenEnabled = macOpenRaw !== "0" && macOpenRaw !== "false";

    // Best effort: clickable notifications require terminal-notifier.
    if (macOpenEnabled && clickUrl && terminalNotifierPath) {
      try {
        $`${terminalNotifierPath} -title ${title} -message ${message} -open ${clickUrl}`
          .nothrow()
          .catch(() => {});
      } catch {
        // ignore
      }
    } else {
      if (macOpenEnabled && clickUrl && !terminalNotifierPath && !didWarnTerminalNotifier) {
        didWarnTerminalNotifier = true;
        if (isDebugEnabled()) {
          console.log(
            "[enhancer] mac click-to-open requires terminal-notifier (brew install terminal-notifier)",
          );
        }
      }

      try {
        const osascript = "/usr/bin/osascript";
        const safeTitle = escapeAppleScriptString(title);
        const safeMessage = escapeAppleScriptString(message);
        const script = `display notification "${safeMessage}" with title "${safeTitle}"`;

        // Fire-and-forget: never block OpenCode event processing.
        $`${osascript} -e ${script}`.nothrow().catch(() => {});
      } catch {
        // ignore
      }
    }

    if (!notifySound) return true;

    try {
      const afplay = "/usr/bin/afplay";
      $`${afplay} ${notifySound}`.nothrow().catch(() => {});
    } catch {
      // ignore
    }

    return true;
  };

  const ntfyUrl = (
    readEnv("OPENCODE_ENHANCER_NOTIFY_NTFY_URL", "OPENCODE_MULTI_AUTH_NOTIFY_NTFY_URL") || ""
  ).trim();
  const ntfyToken = (
    readEnv("OPENCODE_ENHANCER_NOTIFY_NTFY_TOKEN", "OPENCODE_MULTI_AUTH_NOTIFY_NTFY_TOKEN") || ""
  ).trim();
  const notifyUiBaseUrl = (
    readEnv("OPENCODE_ENHANCER_NOTIFY_UI_BASE_URL", "OPENCODE_MULTI_AUTH_NOTIFY_UI_BASE_URL") || ""
  ).trim();

  const getSessionUrl = (sessionID: string): string => {
    const base = (notifyUiBaseUrl || serverUrl?.origin || "").replace(/\/$/, "");
    if (!base) return "";
    return `${base}/session/${sessionID}`;
  };

  const projectLabel =
    (((project as any)?.name as string | undefined) || project?.id || "").trim() || "OpenCode";

  type SessionMeta = { title?: string };
  const sessionMetaCache = new Map<string, SessionMeta>();

  const getSessionMeta = async (sessionID: string): Promise<SessionMeta> => {
    const cached = sessionMetaCache.get(sessionID);
    if (cached?.title) return cached;

    try {
      const res = await client.session.get({
        path: { id: sessionID },
        query: { directory },
      });

      // @opencode-ai/sdk returns { data } shape.
      const data = (res as any)?.data as { title?: string } | undefined;
      const meta: SessionMeta = { title: data?.title };
      sessionMetaCache.set(sessionID, meta);
      return meta;
    } catch {
      const meta: SessionMeta = cached || {};
      sessionMetaCache.set(sessionID, meta);
      return meta;
    }
  };

  const isPrimarySession = async (sessionID: string): Promise<boolean> => {
    try {
      const res = await client.session.get({ path: { id: sessionID }, query: { directory } });
      return !res.data?.parentID;
    } catch {
      return true;
    }
  };

  type NotificationKind = "taskComplete" | "retry" | "error" | "permissionRequest" | "question";

  const shouldNotifyKind = (kind: NotificationKind): boolean => {
    if (!notifyEnabled) return false;
    if (kind === "retry") return true;
    if (kind === "taskComplete") return isNotificationEnabled("taskComplete");
    if (kind === "error") return isNotificationEnabled("error");
    if (kind === "permissionRequest") return isNotificationEnabled("permissionRequest");
    return isNotificationEnabled("question");
  };

  const formatTitle = (kind: NotificationKind): string => {
    if (kind === "taskComplete") return `OpenCode - ${projectLabel}`;
    if (kind === "error") return `OpenCode - ${projectLabel} - Error`;
    if (kind === "retry") return `OpenCode - ${projectLabel} - Retrying`;
    if (kind === "permissionRequest") return `OpenCode - ${projectLabel} - Permission`;
    return `OpenCode - ${projectLabel} - Question`;
  };

  const formatSessionBody = async (
    kind: "taskComplete" | "retry" | "error",
    sessionID: string,
    detail?: string,
  ): Promise<string> => {
    const meta = await getSessionMeta(sessionID);
    const titleLine = meta.title ? `Task: ${meta.title}` : "";
    const url = getSessionUrl(sessionID);

    if (kind === "taskComplete") {
      return [titleLine, `Session finished: ${sessionID}`, detail || "", url]
        .filter(Boolean)
        .join("\n");
    }

    if (kind === "retry") {
      return [titleLine, `Retrying: ${sessionID}`, detail || "", url].filter(Boolean).join("\n");
    }

    return [titleLine, `Error: ${sessionID}`, detail || "", url].filter(Boolean).join("\n");
  };

  const formatContextBody = async (
    sessionID: string | undefined,
    lines: string[],
  ): Promise<string> => {
    const meta = sessionID ? await getSessionMeta(sessionID) : {};
    const titleLine = meta.title ? `Task: ${meta.title}` : "";
    const url = sessionID ? getSessionUrl(sessionID) : "";
    return [titleLine, ...lines, url].filter(Boolean).join("\n");
  };

  const notifyNtfy = async (
    title: string,
    body: string,
    priority: string,
    clickUrl?: string,
  ): Promise<void> => {
    if (!notifyEnabled) return;
    if (!ntfyUrl) return;

    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
      Title: title,
      Priority: priority,
    };

    if (clickUrl) headers["Click"] = clickUrl;
    if (ntfyToken) headers["Authorization"] = `Bearer ${ntfyToken}`;

    try {
      await fetch(ntfyUrl, { method: "POST", headers, body });
    } catch {
      // ignore
    }
  };

  const notifyTargets = async (
    title: string,
    body: string,
    priority: string,
    clickUrl?: string,
  ): Promise<void> => {
    let localDelivered = false;
    const terminalSupport = getTerminalNotificationSupport();
    const mirrorTerminalToSystem = shouldMirrorTerminalNotificationToSystem(terminalSupport);

    if (notifyBackend === "terminal" || (notifyBackend === "auto" && terminalSupport.supported)) {
      try {
        localDelivered = notifyTerminal(title, body);
      } catch {
        localDelivered = false;
      }

      if (!localDelivered && isDebugEnabled()) {
        console.log(
          `[enhancer] terminal notification unavailable (${terminalSupport.reason || terminalSupport.terminal || "write-failed"})`,
        );
      }
    }

    if ((mirrorTerminalToSystem || !localDelivered) && notifyBackend !== "terminal") {
      try {
        localDelivered = notifyMac(title, body, clickUrl) || localDelivered;
      } catch {
        // ignore
      }
    }

    try {
      await notifyNtfy(title, body, priority, clickUrl);
    } catch {
      // ignore
    }
  };
  const shouldThrottle = (key: string, minMs: number): boolean => {
    const last = lastNotifiedAtByKey.get(key) || 0;
    const now = Date.now();
    if (now - last < minMs) return true;
    lastNotifiedAtByKey.set(key, now);
    return false;
  };

  const formatRetryDetail = (status: any): string => {
    const attempt = typeof status?.attempt === "number" ? status.attempt : undefined;
    const message = typeof status?.message === "string" ? status.message : "";
    const next = typeof status?.next === "number" ? status.next : undefined;

    const parts: string[] = [];
    if (typeof attempt === "number") parts.push(`Attempt: ${attempt}`);
    // OpenCode has emitted both "seconds-until-next" and "epoch ms" variants over time.
    if (typeof next === "number") {
      const seconds =
        next > 1e12
          ? Math.max(0, Math.round((next - Date.now()) / 1000))
          : Math.max(0, Math.round(next));
      parts.push(`Next in: ${seconds}s`);
    }
    if (message) parts.push(message);
    return parts.join(" | ");
  };

  const formatErrorDetail = (err: any): string => {
    if (!err || typeof err !== "object") return "";
    const name = typeof err.name === "string" ? err.name : "";
    const code = typeof err.code === "string" ? err.code : "";
    const message =
      (typeof err.message === "string" && err.message) ||
      (typeof err.error?.message === "string" && err.error.message) ||
      "";
    return [name, code, message].filter(Boolean).join(": ");
  };

  const notifySessionEvent = async (
    kind: "taskComplete" | "retry" | "error",
    sessionID: string,
    detail?: string,
  ): Promise<void> => {
    if (!shouldNotifyKind(kind)) return;

    const body = await formatSessionBody(kind, sessionID, detail);
    const priority = kind === "error" ? "5" : kind === "retry" ? "4" : "3";
    const clickUrl = getSessionUrl(sessionID) || undefined;
    await notifyTargets(formatTitle(kind), body, priority, clickUrl);
  };

  const notifyPermissionRequested = async (request: any): Promise<void> => {
    if (!shouldNotifyKind("permissionRequest")) return;

    const sessionID = typeof request?.sessionID === "string" ? request.sessionID : "";
    const permissionLabel =
      (typeof request?.title === "string" && request.title) ||
      (typeof request?.permission === "string" && request.permission) ||
      (typeof request?.type === "string" && request.type) ||
      "Permission request";

    const patterns = [
      ...(Array.isArray(request?.patterns) ? request.patterns : []),
      ...(typeof request?.pattern === "string" ? [request.pattern] : []),
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

    const body = await formatContextBody(sessionID || undefined, [
      `Permission: ${permissionLabel}`,
      patterns.length > 0 ? `Patterns: ${patterns.join(", ")}` : "",
    ]);

    await notifyTargets(
      formatTitle("permissionRequest"),
      body,
      "4",
      sessionID ? getSessionUrl(sessionID) || undefined : undefined,
    );
  };

  const notifyQuestionRequested = async (request: any): Promise<void> => {
    if (!shouldNotifyKind("question")) return;

    const sessionID = typeof request?.sessionID === "string" ? request.sessionID : "";
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    const firstQuestion = questions[0];
    const header = typeof firstQuestion?.header === "string" ? firstQuestion.header : "";
    const prompt = typeof firstQuestion?.question === "string" ? firstQuestion.question : "";
    const extraCount = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
    const optionLabels = Array.isArray(firstQuestion?.options)
      ? firstQuestion.options
          .map((option: any) => (typeof option?.label === "string" ? option.label : ""))
          .filter(Boolean)
      : [];

    const body = await formatContextBody(sessionID || undefined, [
      `Question${header ? `: ${header}` : ""}${extraCount}`,
      prompt,
      optionLabels.length > 0 ? `Options: ${optionLabels.join(", ")}` : "",
    ]);

    await notifyTargets(
      formatTitle("question"),
      body,
      "4",
      sessionID ? getSessionUrl(sessionID) || undefined : undefined,
    );
  };

  return {
    event: async ({ event }) => {
      if (!notifyEnabled) return;
      if (!event || !("type" in event)) return;
      const eventType = (event as any).type as string | undefined;
      if (!eventType) return;

      if (eventType === "permission.asked" || eventType === "permission.updated") {
        const request = (event as any).properties;
        const requestID =
          (typeof request?.id === "string" && request.id) ||
          (typeof request?.permissionID === "string" && request.permissionID) ||
          "unknown";
        if (shouldThrottle(`permission:${requestID}`, 2000)) return;
        await notifyPermissionRequested(request);
        return;
      }

      if (eventType === "question.asked") {
        const request = (event as any).properties;
        const requestID = typeof request?.id === "string" ? request.id : "unknown";
        if (shouldThrottle(`question:${requestID}`, 2000)) return;
        await notifyQuestionRequested(request);
        return;
      }

      if (eventType === "session.created" || eventType === "session.updated") {
        const info = (event as any).properties?.info as { id?: string; title?: string } | undefined;
        const id = info?.id;
        if (id) {
          sessionMetaCache.set(id, { title: info?.title });
        }
        return;
      }

      if (eventType === "session.status") {
        const sessionID = (event as any).properties?.sessionID as string | undefined;
        const status = (event as any).properties?.status;
        const statusType = status?.type as string | undefined;
        if (!sessionID || !statusType) return;

        lastStatusBySession.set(sessionID, statusType);

        if (statusType === "retry") {
          const attempt = typeof status?.attempt === "number" ? status.attempt : undefined;
          const prevAttempt = lastRetryAttemptBySession.get(sessionID);

          if (typeof attempt === "number") {
            if (prevAttempt === attempt && shouldThrottle(`retry:${sessionID}:${attempt}`, 5000)) {
              return;
            }
            lastRetryAttemptBySession.set(sessionID, attempt);
          }

          const key = `retry:${sessionID}:${typeof attempt === "number" ? attempt : "na"}`;
          if (shouldThrottle(key, 2000)) return;

          await notifySessionEvent("retry", sessionID, formatRetryDetail(status));
        }

        return;
      }

      if (eventType === "session.error") {
        const sessionID = (event as any).properties?.sessionID as string | undefined;
        const id = sessionID || "unknown";
        const err = (event as any).properties?.error;
        const detail = formatErrorDetail(err);
        const key = `error:${id}:${detail}`;
        if (shouldThrottle(key, 2000)) return;
        if (sessionID) {
          lastStatusBySession.set(sessionID, "error");
        }
        await notifySessionEvent("error", id, detail);
        return;
      }

      if (eventType === "session.idle") {
        const sessionID = (event as any).properties?.sessionID as string | undefined;
        if (!sessionID) return;

        const prev = lastStatusBySession.get(sessionID);
        if (prev !== "error" && (await isPrimarySession(sessionID))) {
          if (shouldThrottle(`idle:${sessionID}`, 2000)) return;
          await notifySessionEvent("taskComplete", sessionID);
        }

        lastStatusBySession.set(sessionID, "idle");
      }
    },
    "tool.execute.before": async (input) => {
      if (input.tool !== "question") return;
      if (!(await isPrimarySession(input.sessionID))) return;

      if (shouldThrottle(`question-tool:${input.sessionID}`, 2000)) return;

      const body = await formatContextBody(input.sessionID || undefined, [
        "Question requires your input",
      ]);
      await notifyTargets(
        formatTitle("question"),
        body,
        "4",
        input.sessionID ? getSessionUrl(input.sessionID) || undefined : undefined,
      );
    },
    config: async (config) => {
      const openai = (config.provider?.[PROVIDER_ID] as any) || null;
      const configuredAutoSwitchThreshold = normalizePercent(
        openai?.enhancer?.autoSwitchThreshold ??
          openai?.autoSwitchThreshold ??
          (config as any)?.opencodeEnhancer?.autoSwitchThreshold,
      );
      configure({
        autoSwitchThreshold: configuredAutoSwitchThreshold ?? DEFAULT_CONFIG.autoSwitchThreshold,
      });

      const injectModelsRaw = readEnv(
        "OPENCODE_ENHANCER_INJECT_MODELS",
        "OPENCODE_MULTI_AUTH_INJECT_MODELS",
      );
      const injectModels = injectModelsRaw !== "0" && injectModelsRaw !== "false";
      if (!injectModels) return;

      const latestModel = (
        readEnv("OPENCODE_ENHANCER_CODEX_LATEST_MODEL", "OPENCODE_MULTI_AUTH_CODEX_LATEST_MODEL") ||
        "gpt-5.4"
      ).trim();
      try {
        if (!openai || typeof openai !== "object") return;
        openai.models ||= {};
        openai.whitelist ||= [];

        const defaultModels = getDefaultModels();
        const injectedModelIds = [latestModel];
        if (latestModel === "gpt-5.4" && defaultModels["gpt-5.4-fast"]) {
          injectedModelIds.push("gpt-5.4-fast");
        }

        for (const modelID of injectedModelIds) {
          const model = defaultModels[modelID];
          if (!model || openai.models[modelID]) continue;
          openai.models[modelID] = model;
        }

        for (const modelID of injectedModelIds) {
          if (!openai.whitelist.includes(modelID)) {
            openai.whitelist.unshift(modelID);
          }
        }

        if (isDebugEnabled()) {
          console.log(`[enhancer] injected runtime models: ${injectedModelIds.join(", ")}`);
        }
      } catch (err) {
        if (isDebugEnabled()) {
          console.log("[enhancer] config injection failed:", err);
        }
      }
    },

    auth: {
      provider: PROVIDER_ID,

      /**
       * Loader configures the SDK with multi-account rotation
       */
      async loader(getAuth, provider) {
        debugLog("auth.loader invoked");
        await syncAuthFromOpenCode(getAuth);
        const accounts = listAccounts();

        if (accounts.length === 0) {
          console.log("[enhancer] No accounts configured. Run: opencode-enhancer add <alias>");
          return {};
        }

        const customFetch = async (
          input: Request | string | URL,
          init?: RequestInit,
        ): Promise<Response> => {
          await syncAuthFromOpenCode(getAuth);

          const store = loadStore();
          const forceState = getForceState();
          const forcePinned = isForceActive() && !!forceState.forcedAlias;
          const eligibleCount = Object.values(store.accounts).filter((acc) => {
            const now = Date.now();
            return (
              (!acc.rateLimitedUntil || acc.rateLimitedUntil < now) &&
              (!acc.modelUnsupportedUntil || acc.modelUnsupportedUntil < now) &&
              (!acc.workspaceDeactivatedUntil || acc.workspaceDeactivatedUntil < now) &&
              !acc.authInvalid &&
              acc.enabled !== false
            );
          }).length;

          const maxAttempts = forcePinned ? 1 : Math.max(1, eligibleCount);
          const triedAliases = new Set<string>();
          let attempt = 0;

          while (attempt < maxAttempts) {
            attempt++;

            const settings = getRuntimeSettings();
            const effectiveConfig: PluginConfig = {
              ...pluginConfig,
              rotationStrategy: settings.settings.rotationStrategy,
            };

            const rotation = await getNextAccount(effectiveConfig);

            if (!rotation) {
              if (forcePinned && forceState.forcedAlias) {
                const forced = loadStore().accounts[forceState.forcedAlias];
                const now = Date.now();
                if (forced?.rateLimitedUntil && forced.rateLimitedUntil > now) {
                  return new Response(
                    JSON.stringify({
                      error: {
                        code: "RATE_LIMITED",
                        message: `Forced account '${forced.alias}' is rate-limited until ${new Date(forced.rateLimitedUntil).toISOString()}`,
                        details: { alias: forced.alias, rateLimitedUntil: forced.rateLimitedUntil },
                      },
                    }),
                    { status: 429, headers: { "Content-Type": "application/json" } },
                  );
                }
              }
              return new Response(
                JSON.stringify({
                  error: Errors.noEligibleAccounts("No available accounts after filtering"),
                }),
                { status: 503, headers: { "Content-Type": "application/json" } },
              );
            }

            let { account, token } = rotation;

            // Auto-switch: if current account reaches configured used threshold
            // (weekly checked first, then 5h) and there is a better account available,
            // switch to it.
            if (isFeatureEnabled("autoSwitch") && !forcePinned) {
              const currentUsageSnapshot = getUsagePrioritySnapshot(account.rateLimits);
              const autoSwitchUsedTrigger = normalizePercent(pluginConfig.autoSwitchThreshold);
              const currentWeeklyUsed =
                typeof currentUsageSnapshot.weeklyRemaining === "number"
                  ? Math.max(0, Math.min(100, 100 - currentUsageSnapshot.weeklyRemaining))
                  : null;
              const currentFiveHourUsed =
                typeof currentUsageSnapshot.fiveHourRemaining === "number"
                  ? Math.max(0, Math.min(100, 100 - currentUsageSnapshot.fiveHourRemaining))
                  : null;
              const shouldAutoSwitchByUsage =
                typeof autoSwitchUsedTrigger === "number" &&
                ((typeof currentWeeklyUsed === "number" &&
                  currentWeeklyUsed >= autoSwitchUsedTrigger) ||
                  (typeof currentFiveHourUsed === "number" &&
                    currentFiveHourUsed >= autoSwitchUsedTrigger));

              if (shouldAutoSwitchByUsage) {
                const betterAlias = selectBestAvailableAccount(account.alias);
                if (betterAlias) {
                  const betterToken = await ensureValidToken(betterAlias);
                  if (betterToken) {
                    const betterStore = loadStore();
                    const betterAccount = betterStore.accounts[betterAlias];
                    if (betterAccount) {
                      const betterUsageSnapshot = getUsagePrioritySnapshot(
                        betterAccount.rateLimits,
                      );
                      if (compareAccountsByUsagePriority(betterAccount, account) < 0) {
                        if (isDebugEnabled()) {
                          console.log(
                            `[enhancer] Auto-switching from ${account.alias} (weekly used=${typeof currentWeeklyUsed === "number" ? currentWeeklyUsed.toFixed(1) : "unknown"}%, 5h used=${typeof currentFiveHourUsed === "number" ? currentFiveHourUsed.toFixed(1) : "unknown"}%, weekly remaining=${currentUsageSnapshot.weeklyRemaining ?? "unknown"}%, 5h remaining=${currentUsageSnapshot.fiveHourRemaining ?? "unknown"}%) to ${betterAlias} (weekly remaining=${betterUsageSnapshot.weeklyRemaining ?? "unknown"}%, 5h remaining=${betterUsageSnapshot.fiveHourRemaining ?? "unknown"}%)`,
                          );
                        }
                        const switchedStore = promoteSelectedAccount(account.alias, betterAlias);
                        account = switchedStore.accounts[betterAlias] || betterAccount;
                        token = betterToken;
                      }
                    }
                  }
                }
              }
            }

            if (triedAliases.has(account.alias)) {
              continue;
            }
            triedAliases.add(account.alias);

            const decoded = decodeJwtPayload(token);
            const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id || account.accountId;
            if (!accountId) {
              if (attempt < maxAttempts) {
                continue;
              }
              return new Response(
                JSON.stringify({
                  error: {
                    code: "TOKEN_PARSE_ERROR",
                    message:
                      "[enhancer] Failed to extract accountId from token or stored account metadata",
                  },
                }),
                { status: 401, headers: { "Content-Type": "application/json" } },
              );
            }

            const originalUrl = extractRequestUrl(input);
            const url = toCodexBackendUrl(originalUrl);

            let body: Record<string, any> = {};
            try {
              body = init?.body ? JSON.parse(init.body as string) : {};
            } catch {
              body = {};
            }

            const isStreaming = body?.stream === true;
            const normalizedModel = normalizeModel(body.model);
            const fastMode = /-fast$/.test(body.model || "");
            const supportedFastMode = fastMode && normalizedModel === "gpt-5.4";
            const reasoningMatch = body.model?.match(/-(none|low|medium|high|xhigh)$/);

            const payload: Record<string, any> = {
              ...body,
              model: normalizedModel,
              store: false,
            };

            if (payload.truncation === undefined) {
              const truncationRaw = (
                readEnv("OPENCODE_ENHANCER_TRUNCATION", "OPENCODE_MULTI_AUTH_TRUNCATION") || ""
              ).trim();
              if (
                truncationRaw &&
                truncationRaw !== "disabled" &&
                truncationRaw !== "false" &&
                truncationRaw !== "0"
              ) {
                payload.truncation = truncationRaw;
              }
            }

            if (payload.input) {
              payload.input = filterInput(payload.input);
            }

            if (reasoningMatch?.[1]) {
              payload.reasoning = {
                ...(payload.reasoning || {}),
                effort: reasoningMatch[1],
                summary: payload.reasoning?.summary || "auto",
              };
            }

            if (supportedFastMode) {
              payload.service_tier = payload.service_tier || "priority";

              if (isDebugEnabled()) {
                console.log("[enhancer] fast mode enabled: gpt-5.4 + service_tier=priority");
              }
            } else if (fastMode && isDebugEnabled()) {
              console.log(`[enhancer] fast mode ignored for unsupported model: ${normalizedModel}`);
            }

            if (isDebugEnabled() && payload.service_tier === "priority") {
              console.log(`[enhancer] priority service tier requested for ${normalizedModel}`);
            }

            delete payload.reasoning_effort;

            try {
              const headers = new Headers(init?.headers || {});
              headers.delete("x-api-key");
              headers.set("Content-Type", "application/json");
              headers.set("Authorization", `Bearer ${token}`);
              headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
              headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
              headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);

              const cacheKey = payload?.prompt_cache_key;
              if (cacheKey) {
                headers.set(OPENAI_HEADERS.CONVERSATION_ID, cacheKey);
                headers.set(OPENAI_HEADERS.SESSION_ID, cacheKey);
              } else {
                headers.delete(OPENAI_HEADERS.CONVERSATION_ID);
                headers.delete(OPENAI_HEADERS.SESSION_ID);
              }

              headers.set("accept", "text/event-stream");

              const upstreamTimeoutMs = (() => {
                const raw = readEnv(
                  "OPENCODE_ENHANCER_UPSTREAM_TIMEOUT_MS",
                  "OPENCODE_MULTI_AUTH_UPSTREAM_TIMEOUT_MS",
                );
                const parsed = raw ? Number(raw) : NaN;
                return Number.isFinite(parsed) && parsed > 0 ? parsed : TIMEOUTS.UPSTREAM_FETCH_MS;
              })();

              const res = await fetch(url, {
                method: init?.method || "POST",
                headers,
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(upstreamTimeoutMs),
              });

              const limitUpdate = extractRateLimitUpdate(res.headers);
              const mergedRateLimits = limitUpdate
                ? mergeRateLimits(account.rateLimits, limitUpdate)
                : account.rateLimits;
              if (limitUpdate) {
                updateAccount(account.alias, {
                  rateLimits: mergedRateLimits,
                });
              }

              if (res.status === 401 || res.status === 403) {
                const errorData = (await res
                  .clone()
                  .json()
                  .catch(() => ({}))) as { error?: { message?: string } };
                const message = errorData?.error?.message || "";
                if (message.toLowerCase().includes("invalidated") || res.status === 401) {
                  markAuthInvalid(account.alias);
                }

                if (attempt < maxAttempts) {
                  continue;
                }

                return new Response(
                  JSON.stringify({
                    error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases)),
                  }),
                  { status: res.status, headers: { "Content-Type": "application/json" } },
                );
              }

              if (res.status === 429) {
                const errorData = (await res
                  .clone()
                  .json()
                  .catch(() => ({}))) as any;
                const errorText = extractErrorMessage(errorData);
                const rateLimitedUntil = resolveRateLimitedUntil(
                  mergedRateLimits,
                  res.headers,
                  errorText,
                  pluginConfig.rateLimitCooldownMs,
                );
                markRateLimited(account.alias, rateLimitedUntil);

                if (attempt < maxAttempts) {
                  continue;
                }

                return new Response(
                  JSON.stringify({
                    error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases)),
                  }),
                  { status: 429, headers: { "Content-Type": "application/json" } },
                );
              }

              if (res.status === 402) {
                const errorData = (await res
                  .clone()
                  .json()
                  .catch(() => null)) as any;
                const errorText = await res
                  .clone()
                  .text()
                  .catch(() => "");

                const code =
                  (typeof errorData?.detail?.code === "string" && errorData.detail.code) ||
                  (typeof errorData?.error?.code === "string" && errorData.error.code) ||
                  "";
                const message =
                  (typeof errorData?.detail?.message === "string" && errorData.detail.message) ||
                  (typeof errorData?.detail === "string" && errorData.detail) ||
                  (typeof errorData?.error?.message === "string" && errorData.error.message) ||
                  (typeof errorData?.message === "string" && errorData.message) ||
                  errorText ||
                  "";

                const isDeactivatedWorkspace =
                  code === "deactivated_workspace" ||
                  message.toLowerCase().includes("deactivated_workspace") ||
                  message.toLowerCase().includes("deactivated workspace");

                if (isDeactivatedWorkspace) {
                  markWorkspaceDeactivated(
                    account.alias,
                    pluginConfig.workspaceDeactivatedCooldownMs,
                    {
                      error: message || code,
                    },
                  );

                  if (attempt < maxAttempts) {
                    continue;
                  }

                  return new Response(
                    JSON.stringify({
                      error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases)),
                    }),
                    { status: 402, headers: { "Content-Type": "application/json" } },
                  );
                }
              }

              if (res.status === 400) {
                const errorData = (await res
                  .clone()
                  .json()
                  .catch(() => ({}))) as any;
                const message =
                  (typeof errorData?.detail === "string" && errorData.detail) ||
                  (typeof errorData?.error?.message === "string" && errorData.error.message) ||
                  (typeof errorData?.message === "string" && errorData.message) ||
                  "";

                const isModelUnsupported =
                  typeof message === "string" &&
                  message.toLowerCase().includes("model is not supported") &&
                  message.toLowerCase().includes("chatgpt account");

                if (isModelUnsupported) {
                  markModelUnsupported(account.alias, pluginConfig.modelUnsupportedCooldownMs, {
                    model: normalizedModel,
                    error: message,
                  });

                  if (attempt < maxAttempts) {
                    continue;
                  }

                  return new Response(
                    JSON.stringify({
                      error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases)),
                    }),
                    { status: 400, headers: { "Content-Type": "application/json" } },
                  );
                }
              }

              if (!res.ok) {
                return res;
              }

              const responseHeaders = ensureContentType(res.headers);
              if (
                !isStreaming &&
                responseHeaders.get("content-type")?.includes("text/event-stream")
              ) {
                return await convertSseToJson(res, responseHeaders);
              }

              return res;
            } catch (err) {
              return new Response(
                JSON.stringify({
                  error: { code: "REQUEST_FAILED", message: `[enhancer] Request failed: ${err}` },
                }),
                { status: 500, headers: { "Content-Type": "application/json" } },
              );
            }
          }

          return new Response(
            JSON.stringify({
              error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases)),
            }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          );
        };

        // Return SDK configuration with custom fetch for rotation
        return {
          apiKey: "chatgpt-oauth",
          baseURL: CODEX_BASE_URL,
          fetch: customFetch,
        };
      },

      methods: (() => {
        const store = loadStore();
        const aliases = Object.keys(store.accounts || {});
        const hasAccounts = aliases.length > 0;

        debugLog(`auth.methods resolved: hasAccounts=${hasAccounts} aliases=${aliases.length}`);

        if (hasAccounts) {
          // When accounts already exist, show a select with all accounts.
          // Each account auto-resolves with stored credentials — no browser
          // login needed.  The user picks an account and it's instant.
          return [
            {
              label: "Use existing account",
              type: "oauth" as const,

              prompts: [
                {
                  type: "select" as const,
                  key: "alias",
                  message: "Select account",
                  options: [
                    ...aliases.map((a) => buildAccountSelectOption(store.accounts[a])),
                    { label: "+ Add new account", value: "__new__" },
                  ],
                },
              ],

              authorize: async (inputs?: Record<string, string>) => {
                const selectedAlias = inputs?.alias;
                // "Add new account" — full OAuth browser flow
                if (!selectedAlias || selectedAlias === "__new__") {
                  const flow = await createAuthorizationFlow();
                  return {
                    url: flow.url,
                    method: "auto" as const,
                    instructions: "Login with your ChatGPT Plus/Pro account",
                    callback: async () => {
                      try {
                        const account = await loginAccount(undefined, flow);
                        setActiveAlias(account.alias);
                        return {
                          type: "success" as const,
                          provider: PROVIDER_ID,
                          refresh: account.refreshToken,
                          access: account.accessToken,
                          expires: account.expiresAt,
                        };
                      } catch {
                        return { type: "failed" as const };
                      }
                    },
                  };
                }

                // Selected an existing account — auto-resolve with stored tokens.
                // No browser, no re-login. The data: URL opens briefly but
                // the callback resolves instantly.
                const account = loadStore().accounts[selectedAlias];
                if (!account) {
                  // Account was removed — fall through to full OAuth
                  const flow = await createAuthorizationFlow();
                  return {
                    url: flow.url,
                    method: "auto" as const,
                    instructions: "Login with your ChatGPT Plus/Pro account",
                    callback: async () => {
                      try {
                        const acc = await loginAccount(undefined, flow);
                        setActiveAlias(acc.alias);
                        return {
                          type: "success" as const,
                          provider: PROVIDER_ID,
                          refresh: acc.refreshToken,
                          access: acc.accessToken,
                          expires: acc.expiresAt,
                        };
                      } catch {
                        return { type: "failed" as const };
                      }
                    },
                  };
                }

                return {
                  url:
                    "data:text/html,<html><body><h1>Already authenticated</h1><p>Using stored credentials for " +
                    (account.email || account.alias) +
                    ". You can close this tab.</p></body></html>",
                  method: "auto" as const,
                  instructions: `Using stored account: ${account.email || account.alias}`,
                  callback: async () => {
                    setActiveAlias(account.alias);

                    const freshToken = await ensureValidToken(account.alias);
                    if (freshToken) {
                      const refreshed = loadStore().accounts[account.alias];
                      return {
                        type: "success" as const,
                        provider: PROVIDER_ID,
                        refresh: refreshed.refreshToken,
                        access: freshToken,
                        expires: refreshed.expiresAt,
                      };
                    }

                    debugLog(
                      `token refresh failed for ${account.alias}, attempting silent re-auth`,
                    );
                    try {
                      const refreshed = await refreshToken(account.alias);
                      if (refreshed) {
                        return {
                          type: "success" as const,
                          provider: PROVIDER_ID,
                          refresh: refreshed.refreshToken,
                          access: refreshed.accessToken,
                          expires: refreshed.expiresAt,
                        };
                      }
                    } catch {
                      // refresh threw, fall through
                    }

                    return { type: "failed" as const };
                  },
                };
              },
            },
            {
              label: "Add new ChatGPT account",
              type: "oauth" as const,
              authorize: async () => {
                const flow = await createAuthorizationFlow();
                return {
                  url: flow.url,
                  method: "auto" as const,
                  instructions: "Login with your ChatGPT Plus/Pro account",
                  callback: async () => {
                    try {
                      const account = await loginAccount(undefined, flow);
                      setActiveAlias(account.alias);
                      return {
                        type: "success" as const,
                        provider: PROVIDER_ID,
                        refresh: account.refreshToken,
                        access: account.accessToken,
                        expires: account.expiresAt,
                      };
                    } catch {
                      return { type: "failed" as const };
                    }
                  },
                };
              },
            },
            {
              label: "Use API key",
              type: "api" as const,
              prompts: [
                {
                  type: "text" as const,
                  key: "apiKey",
                  message: "Enter your OpenAI API key (sk-...)",
                  placeholder: "sk-...",
                },
              ],
              authorize: async (inputs?: Record<string, string>) => {
                const apiKey = inputs?.apiKey?.trim();
                if (!apiKey) {
                  return { type: "failed" as const };
                }
                return {
                  type: "success" as const,
                  key: apiKey,
                  provider: PROVIDER_ID,
                };
              },
            },
          ];
        }

        // No accounts yet — must go through full OAuth flow or use API key
        return [
          {
            label: "ChatGPT OAuth (Multi-Account)",
            type: "oauth" as const,
            authorize: async () => {
              const flow = await createAuthorizationFlow();
              return {
                url: flow.url,
                method: "auto" as const,
                instructions: "Login with your ChatGPT Plus/Pro account",
                callback: async () => {
                  try {
                    const account = await loginAccount(undefined, flow);
                    setActiveAlias(account.alias);
                    return {
                      type: "success" as const,
                      provider: PROVIDER_ID,
                      refresh: account.refreshToken,
                      access: account.accessToken,
                      expires: account.expiresAt,
                    };
                  } catch {
                    return { type: "failed" as const };
                  }
                },
              };
            },
          },
          {
            label: "Use API key",
            type: "api" as const,
            prompts: [
              {
                type: "text" as const,
                key: "apiKey",
                message: "Enter your OpenAI API key (sk-...)",
                placeholder: "sk-...",
              },
            ],
            authorize: async (inputs?: Record<string, string>) => {
              const apiKey = inputs?.apiKey?.trim();
              if (!apiKey) {
                return { type: "failed" as const };
              }
              return {
                type: "success" as const,
                key: apiKey,
                provider: PROVIDER_ID,
              };
            },
          },
        ];
      })(),
    },
  };
};

export { MultiAuthPlugin as server };
export default MultiAuthPlugin;
