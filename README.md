# opencode-enhancer

OpenCode enhancer for Codex accounts, usage tracking, plugin updates, and future automation.

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
opencode plugin "@rokartur/opencode-enhancer@latest" --global
```

Install the global CLI:

```bash
npm install -g @rokartur/opencode-enhancer
```

## Updates

### Registry

If `opencode-enhancer` is published to a registry, use normal registry updates:

```bash
opencode plugin "@rokartur/opencode-enhancer@latest" --global --force
npm install -g @rokartur/opencode-enhancer@latest
```

### GitHub

If `opencode-enhancer` is installed from GitHub, `plugins update` will detect it and reinstall it using `#semver:*`, which resolves to the newest semver tag.

Examples:

```bash
opencode-enhancer plugins update --dry-run
opencode-enhancer plugins update
```

Other registry plugins are still updated with `@latest`.

## Publishing

### GitHub Actions

Create a repository secret named `NPM_TOKEN` in GitHub:

1. GitHub repository -> `Settings` -> `Secrets and variables` -> `Actions`
2. `New repository secret`
3. Name: `NPM_TOKEN`
4. Value: your npm automation/access token

The workflow in `.github/workflows/publish.yml` will publish automatically when you push a semver tag like `v1.0.2`.

It will:

- install dependencies
- verify that the git tag matches `package.json` version
- run `npm run release:check`
- run `npm publish --access public --provenance`

### Manual Local Publish

For a normal local registry publish flow:

```bash
npm run release:check
npm publish
```

Then users can install the CLI with `npm install -g @rokartur/opencode-enhancer` and the plugin with `opencode plugin "@rokartur/opencode-enhancer@latest" --global`.

### Release Flow

Recommended release flow with GitHub Actions:

```bash
npm version patch
git push origin main
git push origin --tags
```

You can also use `npm version minor` or `npm version major`.

The package is published under the scoped name `@rokartur/opencode-enhancer`, which avoids ownership issues with the unscoped `opencode-enhancer` name.

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
