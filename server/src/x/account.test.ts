import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApplicationStateStore } from "../app-state.js";
import {
  clearXAccount,
  fetchXAccount,
  readXAccount,
  resolveXAccount,
  X_POST_MAX_CHARACTERS,
  X_PREMIUM_POST_MAX_CHARACTERS,
  xPostMaxCharacters,
} from "./account.js";
import { getOAuthFlowStatus } from "./oauth-flow.js";
import { writeTokens } from "./x-tokens.js";

interface RecordedRequest {
  url: string;
  authorization: string | null;
}

function createStore(): ApplicationStateStore {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string): Promise<T | null> {
      return Promise.resolve(values.has(key) ? values.get(key) as T : null);
    },
    set<T>(key: string, value: T): Promise<void> {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

function makeStubFetch(responses: Array<{ status: number; body: unknown }>): {
  fetch: typeof fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  let index = 0;
  const stub: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get("authorization") });
    const planned = responses[index++];
    if (!planned) throw new Error(`Stub fetch out of plan: ${url}`);
    return new Response(JSON.stringify(planned.body), {
      status: planned.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch: stub, calls };
}

function userResponse(subscription: unknown, username = "LongPoster") {
  return {
    status: 200,
    body: {
      data: {
        id: "1",
        name: "Long Poster",
        username,
        ...(subscription === undefined ? {} : { subscription_type: subscription }),
      },
    },
  };
}

async function storeWithTokens(): Promise<ApplicationStateStore> {
  const store = createStore();
  await writeTokens({
    access_token: "live-token",
    refresh_token: "refresh",
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  }, store);
  return store;
}

describe("X account tier", () => {
  it("maps every Premium tier to long posts and the rest to 280", () => {
    expect(xPostMaxCharacters(null)).toBe(X_POST_MAX_CHARACTERS);
    expect(xPostMaxCharacters("None")).toBe(280);
    expect(xPostMaxCharacters("Basic")).toBe(X_PREMIUM_POST_MAX_CHARACTERS);
    expect(xPostMaxCharacters("Premium")).toBe(25_000);
    expect(xPostMaxCharacters("PremiumPlus")).toBe(25_000);
  });

  it("asks /2/users/me for the tier with the stored token and caches it", async () => {
    const store = await storeWithTokens();
    const { fetch: stubFetch, calls } = makeStubFetch([userResponse("Premium", "@LongPoster")]);

    const account = await fetchXAccount({ store, fetchImpl: stubFetch });

    expect(account).toMatchObject({ username: "LongPoster", subscription_type: "Premium" });
    expect(Date.parse(account.fetched_at)).not.toBeNaN();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/2/users/me");
    expect(decodeURIComponent(calls[0]!.url)).toContain("user.fields=username,subscription_type");
    expect(calls[0]!.authorization).toBe("Bearer live-token");
    expect(await readXAccount(store)).toEqual(account);
  });

  it("treats an unknown or missing tier as no subscription", async () => {
    const store = await storeWithTokens();
    const { fetch: stubFetch } = makeStubFetch([userResponse(undefined), userResponse("Gold")]);
    expect((await fetchXAccount({ store, fetchImpl: stubFetch })).subscription_type).toBe("None");
    expect((await fetchXAccount({ store, fetchImpl: stubFetch })).subscription_type).toBe("None");
  });

  it("rejects a response without a username and leaves the cache alone", async () => {
    const store = await storeWithTokens();
    const { fetch: stubFetch } = makeStubFetch([
      { status: 200, body: { data: { id: "1", name: "Nameless" } } },
    ]);
    await expect(fetchXAccount({ store, fetchImpl: stubFetch })).rejects.toThrow(/username/);
    expect(await readXAccount(store)).toBeNull();
  });

  it("serves the cached account unless asked to refresh, and keeps it when X fails", async () => {
    const store = await storeWithTokens();
    const { fetch: stubFetch, calls } = makeStubFetch([
      userResponse("Basic"),
      userResponse("PremiumPlus"),
      { status: 429, body: { title: "Too Many Requests", status: 429 } },
    ]);

    expect(await resolveXAccount({ store, fetchImpl: stubFetch })).toMatchObject({ subscription_type: "Basic" });
    expect(await resolveXAccount({ store, fetchImpl: stubFetch })).toMatchObject({ subscription_type: "Basic" });
    expect(calls).toHaveLength(1);

    expect(await resolveXAccount({ store, fetchImpl: stubFetch, refresh: true }))
      .toMatchObject({ subscription_type: "PremiumPlus" });
    expect(await resolveXAccount({ store, fetchImpl: stubFetch, refresh: true }))
      .toMatchObject({ subscription_type: "PremiumPlus" });
    expect(calls).toHaveLength(3);

    await clearXAccount(store);
    expect(await readXAccount(store)).toBeNull();
  });

  it("ignores a malformed cache entry", async () => {
    const store = createStore();
    await store.set("x.account", { username: 7, subscription_type: "Premium" });
    expect(await readXAccount(store)).toBeNull();
  });
});

describe("getOAuthFlowStatus", () => {
  const originalEnv = { id: process.env.X_CLIENT_ID, secret: process.env.X_CLIENT_SECRET };

  beforeEach(() => {
    process.env.X_CLIENT_ID = "client";
    process.env.X_CLIENT_SECRET = "secret";
  });

  afterEach(() => {
    if (originalEnv.id === undefined) delete process.env.X_CLIENT_ID;
    else process.env.X_CLIENT_ID = originalEnv.id;
    if (originalEnv.secret === undefined) delete process.env.X_CLIENT_SECRET;
    else process.env.X_CLIENT_SECRET = originalEnv.secret;
  });

  it("reports the standard limit and no account when X is not connected", async () => {
    const { fetch: stubFetch, calls } = makeStubFetch([]);
    const status = await getOAuthFlowStatus(createStore(), { fetchImpl: stubFetch });
    expect(status).toMatchObject({
      connected: false,
      account: null,
      post_max_characters: 280,
    });
    expect(calls).toHaveLength(0);
  });

  it("looks the account up once, then reports the tier's post length from the cache", async () => {
    const store = await storeWithTokens();
    const { fetch: stubFetch, calls } = makeStubFetch([
      userResponse("Premium"),
      userResponse("None"),
    ]);

    const first = await getOAuthFlowStatus(store, { fetchImpl: stubFetch });
    expect(first).toMatchObject({
      connected: true,
      account: { username: "LongPoster", subscription_type: "Premium" },
      post_max_characters: 25_000,
    });
    const second = await getOAuthFlowStatus(store, { fetchImpl: stubFetch });
    expect(second.post_max_characters).toBe(25_000);
    expect(calls).toHaveLength(1);

    const refreshed = await getOAuthFlowStatus(store, { fetchImpl: stubFetch, refreshAccount: true });
    expect(refreshed).toMatchObject({
      account: { subscription_type: "None" },
      post_max_characters: 280,
    });
    expect(calls).toHaveLength(2);
  });

  it("falls back to the standard limit when the lookup fails and nothing is cached", async () => {
    const store = await storeWithTokens();
    const { fetch: stubFetch } = makeStubFetch([
      { status: 401, body: { title: "Unauthorized", status: 401 } },
    ]);
    const status = await getOAuthFlowStatus(store, { fetchImpl: stubFetch });
    expect(status).toMatchObject({ connected: true, account: null, post_max_characters: 280 });
  });
});
