# opencode-enhancer

OpenCode enhancer for Codex accounts, usage tracking, plugin updates, and future automation.

## What It Does

- rotates across multiple Codex/OpenAI accounts
- keeps account auth in sync with OpenCode
- tracks usage and cached usage snapshots
- updates other OpenCode plugins from the global config
- provides a local CLI for account and plugin maintenance

## Install

### Local Path

This is the most reliable option.

1. Clone the repository.
2. Build it:

```bash
npm install
npm run build
```

3. Install it into OpenCode from the local path:

```bash
opencode plugin "file:/absolute/path/to/opencode-enhancer" --global
```

### Directly From GitHub

If your OpenCode installation accepts npm-compatible git specs, you can try:

```bash
opencode plugin "git+https://github.com/rokartur/opencode-enhancer.git" --global
```

This repository includes a `prepare` script so the package builds when installed from git.

## CLI

```bash
opencode-enhancer add <alias>
opencode-enhancer remove <alias>
opencode-enhancer list
opencode-enhancer status
opencode-enhancer usage
opencode-enhancer plugins update --dry-run
```

## Data Locations

Default paths:

- store: `~/.config/opencode-enhancer/accounts.json`
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

## GitHub Repo Setup

If you want to publish this through GitHub instead of npm:

```bash
git init -b main
git add .
git commit -m "rename plugin to opencode-enhancer"
git remote add origin git@github.com:rokartur/opencode-enhancer.git
git push -u origin main
```

If the remote already exists, skip the `git remote add` step.

## Development

```bash
npm install
npm run build
npm run lint
```

## License

MIT
