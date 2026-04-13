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
opencode-enhancer add <alias>
opencode-enhancer remove
opencode-enhancer list
opencode-enhancer status
opencode-enhancer usage
opencode-enhancer plugins update --dry-run
```

## Data Locations

Default paths:

- store: `~/.config/opencode-enhancer/settings.json`
- logs: `~/.config/opencode-enhancer/logs/codex-soft.log`
- usage cache: `~/.cache/opencode-enhancer/usage-cache.json`

Legacy `opencode-multi-auth` paths are migrated automatically.

## Environment Variables

Primary variables now use the `OPENCODE_ENHANCER_*` prefix.

Legacy `OPENCODE_MULTI_AUTH_*` and `CODEX_SOFT_*` variables still work as fallback compatibility aliases.

Examples:

- `OPENCODE_ENHANCER_STORE_DIR`
- `OPENCODE_ENHANCER_STORE_FILE`
- `OPENCODE_ENHANCER_STORE_PASSPHRASE`
- `OPENCODE_ENHANCER_CACHE_DIR`
- `OPENCODE_ENHANCER_LOG_PATH`
- `OPENCODE_ENHANCER_CODEX_AUTH_FILE`
- `OPENCODE_ENHANCER_DEBUG`
- `OPENCODE_ENHANCER_USAGE_BASE_URL`
- `OPENCODE_ENHANCER_REFRESH_QUEUE_CONCURRENCY`

Notification-specific examples:

- `OPENCODE_ENHANCER_NOTIFY=1`
- `OPENCODE_ENHANCER_NOTIFY_BACKEND=auto`
- `OPENCODE_ENHANCER_NOTIFY_BACKEND=terminal`
- `OPENCODE_ENHANCER_NOTIFY_BACKEND=system`
- `OPENCODE_ENHANCER_NOTIFY_NTFY_URL=...`

## Notification Settings JSON

Per-event notification toggles live in the persisted store JSON (`~/.config/opencode-enhancer/settings.json`, key `settings.notifications`).

Default values:

```json
{
  "settings": {
    "notifications": {
      "permissionRequest": true,
      "taskComplete": true,
      "error": true,
      "question": true
    }
  }
}
```

These toggles control notifications when the agent:

- asks for permissions
- finishes a task
- emits an error
- asks the user a question

## Terminal-native Notifications

`opencode-enhancer` can now prefer terminal-native desktop notifications emitted through OSC escape sequences instead of AppleScript-style macOS notifications.

Backend selection is controlled with:

```bash
OPENCODE_ENHANCER_NOTIFY_BACKEND=auto
```

Supported values:

- `auto` - prefer terminal-native notifications when running in a supported terminal with access to a real TTY; otherwise fall back to the existing system backend
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
