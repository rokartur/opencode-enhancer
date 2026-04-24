import test from "node:test";
import assert from "node:assert/strict";

import { buildAccountSelectOption, getUniqueAccountSelectAccounts } from "../index.js";
import type { AccountCredentials } from "../types.js";

function account(alias: string, overrides: Partial<AccountCredentials> = {}): AccountCredentials {
  return {
    alias,
    accessToken: `${alias}-access-token`,
    refreshToken: `${alias}-refresh-token`,
    expiresAt: Date.now() + 60 * 60 * 1000,
    usageCount: 0,
    ...overrides,
  };
}

test("getUniqueAccountSelectAccounts dedupes repeated aliases", () => {
  const accounts = [
    account("same", { email: "old@example.com", lastSeenAt: 100 }),
    account("same", { email: "new@example.com", lastSeenAt: 200 }),
    account("other", { email: "other@example.com" }),
  ];

  const unique = getUniqueAccountSelectAccounts(accounts, null);

  assert.deepEqual(
    unique.map((item) => item.alias),
    ["same", "other"],
  );
  assert.equal(unique[0].email, "new@example.com");
});

test("getUniqueAccountSelectAccounts keeps accounts without shared identity", () => {
  const accounts = [account("first"), account("second")];

  const unique = getUniqueAccountSelectAccounts(accounts, null);

  assert.deepEqual(
    unique.map((item) => item.alias),
    ["first", "second"],
  );
});

test("getUniqueAccountSelectAccounts keeps team accounts with shared account id", () => {
  const accounts = [
    account("first", { accountId: "team-account", email: "first@example.com" }),
    account("second", { accountId: "team-account", email: "second@example.com" }),
  ];

  const unique = getUniqueAccountSelectAccounts(accounts, null);

  assert.deepEqual(
    unique.map((item) => item.alias),
    ["first", "second"],
  );
});

test("getUniqueAccountSelectAccounts keeps accounts with shared email", () => {
  const accounts = [
    account("first", { email: "same@example.com" }),
    account("second", { email: "same@example.com" }),
  ];

  const unique = getUniqueAccountSelectAccounts(accounts, null);

  assert.deepEqual(
    unique.map((item) => item.alias),
    ["first", "second"],
  );
});

test("buildAccountSelectOption shows alias as label and email as hint", () => {
  const option = buildAccountSelectOption(
    account("said4-12d4de", {
      email: "said4@rokartur.com",
      rateLimits: {
        fiveHour: { limit: 100, remaining: 69 },
        weekly: { limit: 100, remaining: 85 },
      },
    }),
  );

  assert.equal(option.label, "said4-12d4de");
  assert.equal(option.value, "said4-12d4de");
  assert.equal(option.hint, "said4@rokartur.com · 5h: 69% · wk: 85%");
});
