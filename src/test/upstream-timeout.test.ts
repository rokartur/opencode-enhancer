import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addAccount, invalidateStoreCache, loadStore, setActiveAlias } from "../store.js";

function makeTempStoreFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-enhancer-timeout-test-"));
  return { dir, file: path.join(dir, "settings.json") };
}

function withTempStore<T>(run: () => Promise<T> | T): Promise<T> | T {
  const prevStoreFile = process.env.OPENCODE_ENHANCER_STORE_FILE;
  const prevStoreDir = process.env.OPENCODE_ENHANCER_STORE_DIR;
  const prevTimeout = process.env.OPENCODE_ENHANCER_UPSTREAM_TIMEOUT_MS;
  const prevStreamTimeout = process.env.OPENCODE_ENHANCER_UPSTREAM_STREAM_TIMEOUT_MS;
  const { dir, file } = makeTempStoreFile();

  process.env.OPENCODE_ENHANCER_STORE_FILE = file;
  delete process.env.OPENCODE_ENHANCER_STORE_DIR;
  delete process.env.OPENCODE_ENHANCER_UPSTREAM_TIMEOUT_MS;
  delete process.env.OPENCODE_ENHANCER_UPSTREAM_STREAM_TIMEOUT_MS;
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

    if (prevTimeout === undefined) {
      delete process.env.OPENCODE_ENHANCER_UPSTREAM_TIMEOUT_MS;
    } else {
      process.env.OPENCODE_ENHANCER_UPSTREAM_TIMEOUT_MS = prevTimeout;
    }

    if (prevStreamTimeout === undefined) {
      delete process.env.OPENCODE_ENHANCER_UPSTREAM_STREAM_TIMEOUT_MS;
    } else {
      process.env.OPENCODE_ENHANCER_UPSTREAM_STREAM_TIMEOUT_MS = prevStreamTimeout;
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

function addTestAccount(alias: string, accountId: string): void {
  addAccount(alias, {
    accessToken: `${alias}-access-token`,
    refreshToken: `${alias}-refresh-token`,
    expiresAt: Date.now() + 60 * 60 * 1000,
    accountId,
    email: `${alias}@example.com`,
    source: "opencode",
  });
}

async function importFreshModule<T>(relativePath: string): Promise<T> {
  const url = new URL(`${relativePath}?t=${Date.now()}-${Math.random()}`, import.meta.url);
  return (await import(url.href)) as T;
}

function makeTimeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

async function createCustomFetch(): Promise<
  (input: Request | string | URL, init?: RequestInit) => Promise<Response>
> {
  const { default: MultiAuthPlugin } =
    await importFreshModule<typeof import("../index.js")>("../index.js");

  const shell = (() => ({
    nothrow() {
      return { catch() {} };
    },
    catch() {},
  })) as any;

  const plugin = await MultiAuthPlugin({
    client: {
      session: {
        get: async () => ({ data: {} }),
      },
    },
    $: shell,
    serverUrl: new URL("http://localhost:1455"),
    project: { id: "timeout-test" },
    directory: process.cwd(),
  } as any);

  assert.ok(plugin.auth?.loader);
  const authConfig = await plugin.auth.loader(async () => null as any, {} as any);
  assert.equal(typeof authConfig.fetch, "function");
  return authConfig.fetch;
}

test("stream timeout retries on another account and preserves streaming response", async () => {
  await withTempStore(async () => {
    addTestAccount("slow", "acct-slow");
    addTestAccount("healthy", "acct-healthy");
    setActiveAlias("slow");

    const customFetch = await createCustomFetch();
    const originalFetch = globalThis.fetch;
    const seenAccountIds: string[] = [];
    let calls = 0;

    globalThis.fetch = async (_url, init) => {
      const headers = new Headers(init?.headers || {});
      seenAccountIds.push(headers.get("chatgpt-account-id") || "");
      calls += 1;

      if (calls === 1) {
        throw makeTimeoutError();
      }

      return new Response("data: ok\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    };

    try {
      const response = await customFetch("https://api.openai.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.4", stream: true }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(seenAccountIds, ["acct-slow", "acct-healthy"]);
      assert.match(response.headers.get("content-type") || "", /text\/event-stream/i);

      const store = loadStore();
      assert.match(store.accounts.slow.limitError || "", /timed out/i);
      assert.equal(typeof store.accounts.slow.lastLimitErrorAt, "number");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("non-stream timeout returns 504 with deterministic REQUEST_TIMEOUT error", async () => {
  await withTempStore(async () => {
    addTestAccount("solo", "acct-solo");
    setActiveAlias("solo");

    const customFetch = await createCustomFetch();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => {
      throw makeTimeoutError();
    };

    try {
      const response = await customFetch("https://api.openai.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.4", stream: false }),
      });

      assert.equal(response.status, 504);
      const payload = (await response.json()) as {
        error?: {
          code?: string;
          message?: string;
          details?: {
            aliasesTried?: string[];
            timeoutMs?: number;
            streaming?: boolean;
            alias?: string;
          };
        };
      };

      assert.equal(payload.error?.code, "REQUEST_TIMEOUT");
      assert.match(payload.error?.message || "", /timed out/i);
      assert.deepEqual(payload.error?.details?.aliasesTried, ["solo"]);
      assert.equal(payload.error?.details?.streaming, false);
      assert.equal(payload.error?.details?.alias, "solo");
      assert.equal(payload.error?.details?.timeoutMs, 120000);

      const store = loadStore();
      assert.match(store.accounts.solo.limitError || "", /timed out/i);
      assert.equal(typeof store.accounts.solo.lastLimitErrorAt, "number");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
