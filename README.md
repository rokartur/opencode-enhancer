# opencode-enhancer

OpenCode enhancer for Codex accounts, usage tracking, plugin updates.

## What It Does

- rotates across multiple Codex/OpenAI accounts
- automatically switches to another OpenAI account when the current one runs out of usage or hits limits
- keeps account auth in sync with OpenCode
- tracks usage and cached usage snapshots
- updates other OpenCode plugins from the global config
- provides a local CLI for account and plugin maintenance

## Install

### Registry Install

Recommended stable setup once the package is published to a registry.

Install the OpenCode plugin:

```bash
opencode plugin "opencode-enhancer@latest" --global
```

Install the global CLI:

```bash
npm install -g opencode-enhancer
```

## Updates

### Registry

If `opencode-enhancer` is published to a registry, use normal registry updates:

```bash
opencode plugin "opencode-enhancer@latest" --global --force
npm install -g opencode-enhancer@latest
```

### GitHub

If `opencode-enhancer` is installed from GitHub, `plugins update` will detect it and reinstall it using `#semver:*`, which resolves to the newest semver tag.

Examples:

```bash
opencode-enhancer plugins update --dry-run
opencode-enhancer plugins update
```

Other registry plugins are still updated with `@latest`.

## CLI

```bash
opencode-enhancer add [alias-base]
opencode-enhancer remove
opencode-enhancer list
opencode-enhancer status
opencode-enhancer usage
opencode-enhancer plugins update --dry-run
```

`add` always creates a randomized alias suffix. If you pass `alias-base`, it is used as the alias prefix, e.g. `work-a1b2c3`.

## Data Locations

Default paths:

- store: `~/.config/opencode-enhancer/settings.json`
- logs: `~/.config/opencode-enhancer/logs/codex-soft.log`
- usage cache: `~/.cache/opencode-enhancer/usage-cache.json`

Legacy `opencode-multi-auth` paths are migrated automatically.

## Configuration Reference

This section documents all user-facing configuration surfaces:

1. OpenCode `config.json` (runtime plugin config)
2. persisted enhancer store (`settings.json`)
3. environment variables

### 1) OpenCode `config.json`

Currently supported plugin option:

- `autoSwitchThreshold` (`0..100`, default `90`) — trigger for automatic switching when current account reaches **5h used >= threshold**.

Recognized locations (checked in this order):

1. `provider.openai.enhancer.autoSwitchThreshold`
2. `provider.openai.autoSwitchThreshold`
3. `opencodeEnhancer.autoSwitchThreshold`

Example:

```json
{
	"provider": {
		"openai": {
			"enhancer": {
				"autoSwitchThreshold": 92
			}
		}
	}
}
```

### 2) Persisted settings (`~/.config/opencode-enhancer/settings.json`)

Enhancer stores runtime settings under top-level `settings`:

```jsonc
{
	"settings": {
		// rotationStrategy:
		// - round-robin: cycles through healthy accounts (A -> B -> C -> A...)
		// - least-used: selects the account with the lowest usageCount (then the longest-unused)
		// - random: picks an account from the top half of the health ranking
		// - weighted-round-robin: weighted selection by accountWeights; no weights => fallback to round-robin
		// - usage-priority: selects the account with the largest remaining quota (weekly first, then 5h)
		"rotationStrategy": "usage-priority",

		// number 0..100 (must be < lowThreshold)
		"criticalThreshold": 10,

		// number 0..100 (must be > criticalThreshold)
		"lowThreshold": 30,

		// map { alias: weight }, each weight in (0, 1], sum should be ~1.0
		"accountWeights": {},

		"featureFlags": {
			// boolean
			"antigravityEnabled": false,

			// boolean
			"autoSwitch": true,
		},

		"notifications": {
			// booleans; controls notifications when the agent
			// asks for permissions, finishes a task, emits an error, or asks a question
			"permissionRequest": true,
			"taskComplete": true,
			"error": true,
			"question": true,

			// boolean; when true, `auto` backend on macOS also mirrors
			// notifications through the system backend while the terminal is frontmost
			"whenTerminalActive": false,
		},
	},
}
```

### 3) Environment variables (complete)

Primary prefix is `OPENCODE_ENHANCER_*`.

Most variables also accept legacy aliases with `OPENCODE_MULTI_AUTH_*`. Additionally, `CODEX_SOFT_LOG_PATH` and `CODEX_SOFT_STORE_PASSPHRASE` are still supported for backward compatibility.

#### Core / request behavior

- `OPENCODE_ENHANCER_DEBUG` — verbose debug logs (`1` enables).
- `OPENCODE_ENHANCER_UPSTREAM_TIMEOUT_MS` — upstream request timeout in ms (default: `120000`).
- `OPENCODE_ENHANCER_UPSTREAM_STREAM_TIMEOUT_MS` — upstream streaming request timeout in ms (defaults to `OPENCODE_ENHANCER_UPSTREAM_TIMEOUT_MS` when set, otherwise `900000`).
- `OPENCODE_ENHANCER_TOKEN_FAILURE_COOLDOWN_MS` — cooldown when token refresh fails (default: `60000`).
- `OPENCODE_ENHANCER_TRUNCATION` — forces request `truncation` when payload does not specify it (`0|false|disabled` means no override).
- `OPENCODE_ENHANCER_USAGE_BASE_URL` — override usage API base URL (default: `https://chatgpt.com/backend-api`).

#### Model routing / injection

- `OPENCODE_ENHANCER_PREFER_CODEX_LATEST` — when `1|true`, maps older codex model ids to latest model.
- `OPENCODE_ENHANCER_CODEX_LATEST_MODEL` — target latest model id (default: `gpt-5.4`).
- `OPENCODE_ENHANCER_INJECT_MODELS` — runtime model injection toggle (`0|false` disables).

#### Store / cache / paths

- `OPENCODE_ENHANCER_STORE_DIR` — enhancer store directory.
- `OPENCODE_ENHANCER_STORE_FILE` — enhancer store file path.
- `OPENCODE_ENHANCER_STORE_PASSPHRASE` — passphrase for encrypted store.
- `OPENCODE_ENHANCER_CACHE_DIR` — usage cache directory.
- `OPENCODE_ENHANCER_LOG_PATH` — log file path.
- `OPENCODE_ENHANCER_CODEX_AUTH_FILE` — path to Codex auth file.
- `OPENCODE_ENHANCER_REFRESH_QUEUE_CONCURRENCY` — refresh queue concurrency (default `20`, max `20`).

#### Feature/settings overrides

- `OPENCODE_ENHANCER_ROTATION_STRATEGY` — `round-robin|least-used|random|weighted-round-robin|usage-priority`.
- `OPENCODE_ENHANCER_CRITICAL_THRESHOLD` — settings override `0..100`.
- `OPENCODE_ENHANCER_LOW_THRESHOLD` — settings override `0..100`.
- `OPENCODE_ENHANCER_ANTIGRAVITY_ENABLED` — feature flag override (`1|true`).
- `OPENCODE_ENHANCER_AUTOSWITCH_ENABLED` — feature flag override (`1|true`).

#### Notifications

- `OPENCODE_ENHANCER_NOTIFY` — global notifications toggle (`0|false` disables).
- `OPENCODE_ENHANCER_NOTIFY_BACKEND` — `auto|terminal|system`.
- `OPENCODE_ENHANCER_NOTIFY_WHEN_TERMINAL_ACTIVE` — `1|true` overrides settings and enables system notification mirroring in `auto` mode when the supported terminal app is frontmost.
- `OPENCODE_ENHANCER_NOTIFY_SOUND` — sound path for macOS system notifications.
- `OPENCODE_ENHANCER_NOTIFY_MAC_OPEN` — macOS click-to-open support toggle (`0|false` disables).
- `OPENCODE_ENHANCER_NOTIFY_NTFY_URL` — optional ntfy endpoint.
- `OPENCODE_ENHANCER_NOTIFY_NTFY_TOKEN` — optional ntfy token.
- `OPENCODE_ENHANCER_NOTIFY_UI_BASE_URL` — base URL for session links in notifications.

#### Limits probing / provider auth (advanced)

- `OPENCODE_ENHANCER_PROBE_EFFORT` — `low|medium|high` (default: `low`).
- `OPENCODE_ENHANCER_LIMITS_PROBE_MODELS` — comma-separated probe model list.
- `OPENCODE_ENHANCER_GOOGLE_CLIENT_ID` — Gemini OAuth client id override.
- `OPENCODE_ENHANCER_GOOGLE_CLIENT_SECRET` — Gemini OAuth client secret override.

## Terminal-native Notifications

`opencode-enhancer` can now prefer terminal-native desktop notifications emitted through OSC escape sequences instead of AppleScript-style macOS notifications.

Backend selection is controlled with:

```bash
OPENCODE_ENHANCER_NOTIFY_BACKEND=auto
```

Supported values:

- `auto` - prefer terminal-native notifications when running in a supported terminal with access to a real TTY; otherwise fall back to the existing system backend. If `settings.notifications.whenTerminalActive` is `true` (or `OPENCODE_ENHANCER_NOTIFY_WHEN_TERMINAL_ACTIVE=1`), macOS also mirrors alerts through the system backend while the supported terminal app is frontmost.
- `terminal` - use terminal-native notifications only; do not fall back to the system backend
- `system` - always use the existing system backend (`osascript` / `terminal-notifier` on macOS)

Current terminal-native target matrix:

- Ghostty - supported via `OSC 9`
- iTerm2 - supported via `OSC 9`
- kitty - supported via legacy `OSC 9`
- WezTerm - supported via `OSC 9` (visibility depends on WezTerm notification settings)

Notes and limitations:

- Terminal-native notifications require the plugin process to reach the controlling terminal. The implementation first tries `/dev/tty`, then falls back to a TTY stderr/stdout stream.
- `tmux`, `screen`, and `zellij` are not supported in this first slice; they may intercept OSC unless passthrough is configured.
- On macOS/Linux, the terminal app itself must be allowed to show notifications by the OS.
- On macOS in `auto` mode, frontmost Ghostty/iTerm2/kitty/WezTerm sessions trigger the system notification path only when `settings.notifications.whenTerminalActive` is enabled, or the env override is set to `1`.
- In WezTerm, `notification_handling` must not be set to `NeverShow`.
- Terminal-native notifications intentionally use a compact single-line payload. Click-to-open URLs are still only available through the existing system backend.

Quick manual checks:

```bash
# Ghostty / iTerm2 / kitty / WezTerm
printf '\e]9;OpenCode test notification\e\\'
```

Repo helper for a quick smoke test:

```bash
npm run notify:smoke
npm run notify:smoke -- --check
npm run notify:smoke -- --title "OpenCode smoke" --message "Ghostty/iTerm2/kitty/WezTerm"
```

What it does:

- detects whether the current terminal matches the same support heuristic used by the plugin
- prints TTY diagnostics (`/dev/tty`, `stderr.isTTY`, `stdout.isTTY`)
- sends a single `OSC 9` notification when supported

If you want the old behavior regardless of terminal support:

```bash
OPENCODE_ENHANCER_NOTIFY_BACKEND=system
```
