import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  addAccount,
  getStorePath,
  invalidateStoreCache,
  loadStore,
  removeAccount,
  updateAccount,
} from "../store.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withTempStore<T>(run: () => Promise<T> | T): Promise<T> | T {
  const prevStoreFile = process.env.OPENCODE_ENHANCER_STORE_FILE;
  const prevStoreDir = process.env.OPENCODE_ENHANCER_STORE_DIR;
  const dir = makeTempDir("opencode-enhancer-test-");
  const file = path.join(dir, "settings.json");

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

function withTempCodexAuthFile<T>(run: (authFile: string) => Promise<T> | T): Promise<T> | T {
  const prevAuthFile = process.env.OPENCODE_ENHANCER_CODEX_AUTH_FILE;
  const dir = makeTempDir("opencode-enhancer-codex-auth-");
  const authFile = path.join(dir, "auth.json");

  process.env.OPENCODE_ENHANCER_CODEX_AUTH_FILE = authFile;

  const restore = () => {
    if (prevAuthFile === undefined) {
      delete process.env.OPENCODE_ENHANCER_CODEX_AUTH_FILE;
    } else {
      process.env.OPENCODE_ENHANCER_CODEX_AUTH_FILE = prevAuthFile;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };

  try {
    const result = run(authFile);
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

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function addTrackedAccount(alias: string): void {
  addAccount(alias, {
    accessToken: `${alias}-access-token`,
    refreshToken: `${alias}-refresh-token`,
    expiresAt: Date.now() + 60 * 60 * 1000,
    email: "removed@example.com",
    accountId: "acct-removed",
    accountUserId: "acct-user-removed",
    userId: "user-removed",
    source: "opencode",
  });
}

async function importFreshModule<T>(relativePath: string): Promise<T> {
  const url = new URL(`${relativePath}?t=${Date.now()}-${Math.random()}`, import.meta.url);
  return (await import(url.href)) as T;
}

test("removeAccount persists a tombstone and flushes it immediately", () => {
  withTempStore(() => {
    addTrackedAccount("gone");

    removeAccount("gone");
    invalidateStoreCache();

    const store = loadStore();
    assert.deepEqual(Object.keys(store.accounts), []);
    assert.equal(store.activeAlias, null);
    assert.equal(store.removedAccounts?.length, 1);
    assert.equal(store.removedAccounts?.[0].accountId, "acct-removed");
    assert.equal(store.removedAccounts?.[0].accountUserId, "acct-user-removed");
    assert.equal(store.removedAccounts?.[0].userId, "user-removed");
    assert.equal(store.removedAccounts?.[0].email, "removed@example.com");
  });
});

test("addAccount flushes the new account immediately", () => {
  withTempStore(() => {
    addTrackedAccount("new-account");
    invalidateStoreCache();

    const store = loadStore();
    assert.deepEqual(Object.keys(store.accounts), ["new-account"]);
  });
});

test("updateAccount preserves accounts added by another store writer", () => {
  withTempStore(() => {
    addTrackedAccount("first");
    const staleStore = loadStore();
    const externalAccount = {
      accessToken: "external-access-token",
      refreshToken: "external-refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
      alias: "external",
      usageCount: 0,
      email: "external@example.com",
    };

    fs.writeFileSync(
      getStorePath(),
      JSON.stringify(
        {
          ...staleStore,
          accounts: {
            ...staleStore.accounts,
            external: externalAccount,
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    updateAccount("first", { notes: "updated" });
    invalidateStoreCache();

    const store = loadStore();
    assert.deepEqual(Object.keys(store.accounts).sort(), ["external", "first"]);
    assert.equal(store.accounts.first.notes, "updated");
  });
});

test("syncAuthFromOpenCode does not recreate a removed account", async () => {
  await withTempStore(async () => {
    addTrackedAccount("gone");
    removeAccount("gone");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 500 });

    try {
      const { syncAuthFromOpenCode } =
        await importFreshModule<typeof import("../auth-sync.js")>("../auth-sync.js");
      const access = makeJwt({
        email: "removed@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-removed",
          chatgpt_account_user_id: "acct-user-removed",
          user_id: "user-removed",
        },
      });

      await syncAuthFromOpenCode(async () => ({
        type: "oauth",
        access,
        refresh: "fresh-refresh-token",
        expires: Date.now() + 60 * 60 * 1000,
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }

    const store = loadStore();
    assert.deepEqual(Object.keys(store.accounts), []);
    assert.equal(store.removedAccounts?.length, 1);
  });
});

test("syncCodexAuthFile does not recreate a removed account", async () => {
  await withTempStore(async () => {
    await withTempCodexAuthFile(async (authFile) => {
      addTrackedAccount("gone");
      removeAccount("gone");

      const access = makeJwt({
        email: "removed@example.com",
        exp: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-removed",
          chatgpt_account_user_id: "acct-user-removed",
          user_id: "user-removed",
        },
      });

      fs.writeFileSync(
        authFile,
        JSON.stringify(
          {
            tokens: {
              access_token: access,
              refresh_token: "fresh-refresh-token",
              account_id: "acct-removed",
            },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );

      const { syncCodexAuthFile } =
        await importFreshModule<typeof import("../codex-auth.js")>("../codex-auth.js");
      const result = syncCodexAuthFile({ allowAdd: true, setActiveAlias: false });

      assert.equal(result.alias, null);
      assert.equal(result.added, false);

      const store = loadStore();
      assert.deepEqual(Object.keys(store.accounts), []);
      assert.equal(store.removedAccounts?.length, 1);
    });
  });
});

test("explicit add clears the removed-account tombstone", () => {
  withTempStore(() => {
    addTrackedAccount("gone");
    removeAccount("gone");

    addAccount(
      "restored",
      {
        accessToken: "restored-access-token",
        refreshToken: "restored-refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        email: "removed@example.com",
        accountId: "acct-removed",
        accountUserId: "acct-user-removed",
        userId: "user-removed",
        source: "opencode",
      },
      { clearRemoved: true },
    );

    const store = loadStore();
    assert.deepEqual(Object.keys(store.accounts), ["restored"]);
    assert.equal(store.removedAccounts?.length, 0);
  });
});
