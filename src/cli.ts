#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loginAccount } from "./auth.js";
import { removeAccount, listAccounts, getStorePath, loadStore } from "./store.js";
import { runPluginsUpdateCommand } from "./plugin-updates.js";
import { runUsageCommand } from "./usage-command.js";

const args = process.argv.slice(2);
const command = args[0];
const alias = args[1];

function getFlagValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function formatAccountUsageHint(account: ReturnType<typeof listAccounts>[number]): string {
  const parts: string[] = [];

  const fiveHour = account.rateLimits?.fiveHour;
  if (typeof fiveHour?.remaining === "number") {
    if (typeof fiveHour.limit === "number" && fiveHour.limit !== 100) {
      parts.push(`5h ${fiveHour.remaining}/${fiveHour.limit} left`);
    } else {
      parts.push(`5h ${fiveHour.remaining}% left`);
    }
  }

  const weekly = account.rateLimits?.weekly;
  if (typeof weekly?.remaining === "number") {
    if (typeof weekly.limit === "number" && weekly.limit !== 100) {
      parts.push(`weekly ${weekly.remaining}/${weekly.limit} left`);
    } else {
      parts.push(`weekly ${weekly.remaining}% left`);
    }
  }

  return parts.join(" · ");
}

function formatAccountOption(
  account: ReturnType<typeof listAccounts>[number],
  activeAlias: string | null,
): string {
  const primary = account.email?.trim() || account.alias;
  const secondary = primary === account.alias ? "" : ` (${account.alias})`;
  const active = account.alias === activeAlias ? " [active]" : "";
  const usage = formatAccountUsageHint(account);
  return usage ? `${primary}${secondary}${active} - ${usage}` : `${primary}${secondary}${active}`;
}

async function selectAccountAliasForRemoval(): Promise<string | null> {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    console.log("No accounts configured.");
    return null;
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive account selection requires a TTY.");
  }

  const store = loadStore();
  console.log("\nSelect account to remove:\n");
  for (const [index, account] of accounts.entries()) {
    console.log(`  ${index + 1}. ${formatAccountOption(account, store.activeAlias)}`);
  }
  console.log("  0. Cancel\n");

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = (await rl.question("Choose account: ")).trim();
      const choice = Number.parseInt(answer, 10);

      if (Number.isNaN(choice)) {
        console.log("Enter a number from the list.");
        continue;
      }

      if (choice === 0) {
        console.log("Removal cancelled.");
        return null;
      }

      const selected = accounts[choice - 1];
      if (selected) {
        return selected.alias;
      }

      console.log(`Choose a number between 0 and ${accounts.length}.`);
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  switch (command) {
    case "add":
    case "login": {
      if (!alias) {
        console.error("Usage: opencode-enhancer add <alias>");
        console.error("Example: opencode-enhancer add work");
        process.exit(1);
      }
      try {
        const account = await loginAccount(alias);
        console.log(`\nAccount "${alias}" added successfully!`);
        console.log(`Email: ${account.email || "unknown"}`);
      } catch (err) {
        console.error(`Failed to add account: ${err}`);
        process.exit(1);
      }
      break;
    }

    case "remove":
    case "rm": {
      if (alias) {
        console.error("Usage: opencode-enhancer remove");
        process.exit(1);
      }
      try {
        const selectedAlias = await selectAccountAliasForRemoval();
        if (!selectedAlias) {
          break;
        }
        removeAccount(selectedAlias);
        console.log(`Account "${selectedAlias}" removed.`);
      } catch (err) {
        console.error(`Failed to remove account: ${err}`);
        process.exit(1);
      }
      break;
    }

    case "list":
    case "ls": {
      const accounts = listAccounts();
      if (accounts.length === 0) {
        console.log("No accounts configured.");
        console.log("Add one with: opencode-enhancer add <alias>");
      } else {
        console.log("\nConfigured accounts:\n");
        for (const acc of accounts) {
          console.log(`  ${acc.alias}: ${acc.email || "unknown email"} (uses: ${acc.usageCount})`);
        }
        console.log();
      }
      break;
    }

    case "status": {
      const store = loadStore();
      const accounts = Object.values(store.accounts);
      const strategy =
        store.settings?.rotationStrategy || store.rotationStrategy || "usage-priority";

      console.log("\n[enhancer] Account Status\n");
      console.log(`Strategy: ${strategy}`);
      console.log(`Accounts: ${accounts.length}`);
      console.log(`Active: ${store.activeAlias || "none"}\n`);

      if (accounts.length === 0) {
        console.log("No accounts configured. Run: opencode-enhancer add <alias>\n");
        return;
      }

      for (const acc of accounts) {
        const isActive = acc.alias === store.activeAlias ? " (active)" : "";
        const isRateLimited =
          acc.rateLimitedUntil && acc.rateLimitedUntil > Date.now()
            ? ` [RATE LIMITED until ${new Date(acc.rateLimitedUntil).toLocaleTimeString()}]`
            : "";
        const expiry = new Date(acc.expiresAt).toLocaleString();

        console.log(`  ${acc.alias}${isActive}${isRateLimited}`);
        console.log(`    Email: ${acc.email || "unknown"}`);
        console.log(`    Uses: ${acc.usageCount}`);
        console.log(`    Token expires: ${expiry}`);
        console.log();
      }
      break;
    }

    case "path": {
      console.log(getStorePath());
      break;
    }

    case "usage": {
      const providerArg = getFlagValue("--provider");
      const jsonFlag = args.includes("--json");
      const verboseFlag = args.includes("--verbose") || args.includes("-v");
      const noCacheFlag = args.includes("--no-cache");
      await runUsageCommand({
        provider: providerArg || undefined,
        json: jsonFlag,
        verbose: verboseFlag,
        noCache: noCacheFlag,
      });
      break;
    }

    case "plugins": {
      const action = args[1] || "help";
      if (action !== "update") {
        console.error(
          "Usage: opencode-enhancer plugins update [--dry-run] [--include-pinned] [--exclude name1,name2]",
        );
        process.exit(1);
      }

      const exclude = (getFlagValue("--exclude") || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      await runPluginsUpdateCommand({
        dryRun: hasFlag("--dry-run"),
        includePinned: hasFlag("--include-pinned"),
        exclude,
      });
      break;
    }

    case "help":
    case "--help":
    case "-h":
    default: {
      console.log(`
opencode-enhancer - OpenCode enhancer for Codex accounts, usage, plugin updates, and automation

Commands:
  add <alias>      Add a new account (opens browser for OAuth)
  remove           Remove an account (opens selector)
  list             List all configured accounts
  status           Show detailed account status
  usage            Check usage/quota across all connected providers
  plugins update   Update configured plugins and self-update from GitHub tags
  path             Show config file location
  help             Show this help message

Usage options:
  --provider <id>  Check a single provider (claude, codex, gemini, copilot,
                    openrouter, opencode, kimi, minimax, zai, nanogpt, synthetic, chutes)
  --json           Output raw JSON
  --verbose, -v    Show per-account details for multi-account providers
  --no-cache       Skip cache, always fetch fresh data
  --dry-run        Show planned plugin updates without executing them
  --include-pinned Also update plugins pinned to a non-latest version
  --exclude <ids>  Comma-separated plugin names to skip during update

Examples:
  opencode-enhancer add personal
  opencode-enhancer add work
  opencode-enhancer add backup
  opencode-enhancer status
  opencode-enhancer usage
  opencode-enhancer usage --provider claude
  opencode-enhancer usage --json
  opencode-enhancer plugins update --dry-run
  opencode-enhancer plugins update --exclude oh-my-openagent

After adding accounts, the plugin auto-rotates between them.
`);
      break;
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
