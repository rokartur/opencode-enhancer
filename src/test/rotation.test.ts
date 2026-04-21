import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG } from "../types.js";
import { getNextAccount } from "../rotation.js";
import { compareAccountsByUsagePriority, getMinRemaining } from "../account-ranking.js";
import {
  addAccount,
  invalidateStoreCache,
  loadStore,
  promoteSelectedAccount,
  setActiveAlias,
  updateAccount,
} from "../store.js";

function makeTempStoreFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-enhancer-test-"));
  return { dir, file: path.join(dir, "settings.json") };
}

function withTempStore<T>(run: () => Promise<T> | T): Promise<T> | T {
  const prevStoreFile = process.env.OPENCODE_ENHANCER_STORE_FILE;
  const prevStoreDir = process.env.OPENCODE_ENHANCER_STORE_DIR;
  const { dir, file } = makeTempStoreFile();

  process.env.OPENCODE_ENHANCER_STORE_FILE = file;
  delete process.env.OPENCODE_ENHANCER_STORE_DIR;
  invalidateStoreCache();

  const restore = () => {
    invalidateStoreCache();
    if (prevStoreFile === undefined) {
      delete process.env.OPENCODE_ENHANCER_STORE_FILE;
    } else {
      process.env.OPENCODE_ENHANCER_STORE_FILE = prevStoreFile;
    }
    if (prevStoreDir === undefined) {
      delete process.env.OPENCODE_ENHANCER_STORE_DIR;
    } else {
      process.env.OPENCODE_ENHANCER_STORE_DIR = prevStoreDir;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };

  try {
    const result = run();
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function addTestAccount(
  alias: string,
  rateLimits: {
    fiveHour?: { remaining?: number; limit?: number };
    weekly?: { remaining?: number; limit?: number };
  },
): void {
  addAccount(alias, {
    accessToken: `${alias}-access-token`,
    refreshToken: `${alias}-refresh-token`,
    expiresAt: Date.now() + 60 * 60 * 1000,
    rateLimits: {
      fiveHour: rateLimits.fiveHour
        ? {
            limit: rateLimits.fiveHour.limit ?? 100,
            remaining: rateLimits.fiveHour.remaining,
            updatedAt: Date.now(),
          }
        : undefined,
      weekly: rateLimits.weekly
        ? {
            limit: rateLimits.weekly.limit ?? 100,
            remaining: rateLimits.weekly.remaining,
            updatedAt: Date.now(),
          }
        : undefined,
    },
    authInvalid: false,
  });
}

test("getNextAccount switches away when active account reaches exact 90% 5h usage", async () => {
  await withTempStore(async () => {
    addTestAccount("busy", {
      fiveHour: { remaining: 10 },
      weekly: { remaining: 50 },
    });
    addTestAccount("free", {
      fiveHour: { remaining: 100 },
      weekly: { remaining: 50 },
    });
    setActiveAlias("busy");

    const result = await getNextAccount({
      ...DEFAULT_CONFIG,
      rotationStrategy: "usage-priority",
      autoSwitchThreshold: 90,
    });

    assert.ok(result);
    assert.equal(result.account.alias, "free");
    assert.equal(result.token, "free-access-token");

    const store = loadStore();
    assert.equal(store.activeAlias, "free");
    assert.equal(store.accounts.busy.usageCount, 0);
    assert.equal(store.accounts.free.usageCount, 1);
  });
});

test("getNextAccount keeps active account when it stays above the 90% 5h switch floor", async () => {
  await withTempStore(async () => {
    addTestAccount("busy", {
      fiveHour: { remaining: 11 },
      weekly: { remaining: 50 },
    });
    addTestAccount("free", {
      fiveHour: { remaining: 100 },
      weekly: { remaining: 50 },
    });
    setActiveAlias("busy");

    const result = await getNextAccount({
      ...DEFAULT_CONFIG,
      rotationStrategy: "usage-priority",
      autoSwitchThreshold: 90,
    });

    assert.ok(result);
    assert.equal(result.account.alias, "busy");
    assert.equal(result.token, "busy-access-token");

    const store = loadStore();
    assert.equal(store.activeAlias, "busy");
    assert.equal(store.accounts.busy.usageCount, 1);
    assert.equal(store.accounts.free.usageCount, 0);
  });
});

test("promoteSelectedAccount persists active alias and moves usage to final account", () => {
  withTempStore(() => {
    addTestAccount("first", {
      fiveHour: { remaining: 10 },
      weekly: { remaining: 60 },
    });
    addTestAccount("second", {
      fiveHour: { remaining: 90 },
      weekly: { remaining: 60 },
    });
    setActiveAlias("first");
    updateAccount("first", {
      usageCount: 1,
      lastUsed: 100,
    });

    const switched = promoteSelectedAccount("first", "second", 1234);

    assert.equal(switched.activeAlias, "second");
    assert.equal(switched.accounts.first.usageCount, 0);
    assert.equal(switched.accounts.second.usageCount, 1);
    assert.equal(switched.accounts.second.lastUsed, 1234);
  });
});

test("getNextAccount switches away when 5h is exhausted despite higher weekly remaining", async () => {
  await withTempStore(async () => {
    addTestAccount("exhausted", {
      fiveHour: { remaining: 0 },
      weekly: { remaining: 81 },
    });
    addTestAccount("healthy", {
      fiveHour: { remaining: 80 },
      weekly: { remaining: 50 },
    });
    setActiveAlias("exhausted");

    const result = await getNextAccount({
      ...DEFAULT_CONFIG,
      rotationStrategy: "usage-priority",
      autoSwitchThreshold: 90,
    });

    assert.ok(result);
    assert.equal(result.account.alias, "healthy");

    const store = loadStore();
    assert.equal(store.activeAlias, "healthy");
  });
});

test("compareAccountsByUsagePriority: exhausted 5h ranks lower despite higher weekly", () => {
  const accountA: Parameters<typeof compareAccountsByUsagePriority>[0] = {
    alias: "exhausted",
    accessToken: "a",
    refreshToken: "a",
    expiresAt: 0,
    rateLimits: {
      fiveHour: { remaining: 0, updatedAt: Date.now() },
      weekly: { remaining: 81, updatedAt: Date.now() },
    },
    authInvalid: false,
    usageCount: 0,
  };
  const accountB: Parameters<typeof compareAccountsByUsagePriority>[0] = {
    alias: "healthy",
    accessToken: "b",
    refreshToken: "b",
    expiresAt: 0,
    rateLimits: {
      fiveHour: { remaining: 80, updatedAt: Date.now() },
      weekly: { remaining: 50, updatedAt: Date.now() },
    },
    authInvalid: false,
    usageCount: 0,
  };

  assert.ok(
    compareAccountsByUsagePriority(accountA, accountB) > 0,
    "A (exhausted 5h) should rank lower than B (healthy)",
  );
});

test("getMinRemaining returns 0 when one window is exhausted", () => {
  assert.equal(
    getMinRemaining({
      fiveHour: { remaining: 0, updatedAt: Date.now() },
      weekly: { remaining: 81, updatedAt: Date.now() },
    }),
    0,
  );
});
