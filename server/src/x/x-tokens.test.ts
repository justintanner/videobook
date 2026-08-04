import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ApplicationStateStore } from "../app-state.js";
import {
  getValidAccessToken,
  readTokens,
  refreshTokens,
  writeTokens,
  type XTokenState,
} from "./x-tokens.js";

interface RecordedRequest {
  url: string;
  method: string;
  body: string | null;
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
  let i = 0;
  const stub: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const headers: Record<string, string> = {};
    if (init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    let bodyStr: string | null = null;
    const rawBody = init?.body;
    if (typeof rawBody === "string") {
      bodyStr = rawBody;
    } else if (rawBody instanceof URLSearchParams) {
      bodyStr = rawBody.toString();
    } else if (rawBody) {
      bodyStr = "[non-string]";
    }
    calls.push({
      url,
      method: (init?.method as string) ?? "GET",
      body: bodyStr,
      authorization: headers.authorization ?? null,
    });
    const planned = responses[i++];
    if (!planned) throw new Error(`Stub fetch out of plan: ${url}`);
    return new Response(JSON.stringify(planned.body), {
      status: planned.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch: stub, calls };
}

describe("x-tokens", () => {
  let store: ApplicationStateStore;
  const originalEnv = {
    X_ACCESS_TOKEN: process.env.X_ACCESS_TOKEN,
    X_CLIENT_ID: process.env.X_CLIENT_ID,
    X_CLIENT_SECRET: process.env.X_CLIENT_SECRET,
  };

  beforeEach(() => {
    store = createStore();
    delete process.env.X_ACCESS_TOKEN;
    delete process.env.X_CLIENT_ID;
    delete process.env.X_CLIENT_SECRET;
  });

  afterEach(() => {
    if (originalEnv.X_ACCESS_TOKEN !== undefined) {
      process.env.X_ACCESS_TOKEN = originalEnv.X_ACCESS_TOKEN;
    } else {
      delete process.env.X_ACCESS_TOKEN;
    }
    if (originalEnv.X_CLIENT_ID !== undefined) {
      process.env.X_CLIENT_ID = originalEnv.X_CLIENT_ID;
    } else {
      delete process.env.X_CLIENT_ID;
    }
    if (originalEnv.X_CLIENT_SECRET !== undefined) {
      process.env.X_CLIENT_SECRET = originalEnv.X_CLIENT_SECRET;
    } else {
      delete process.env.X_CLIENT_SECRET;
    }
  });

  it("returns access_token from application state when not near expiry", async () => {
    const state: XTokenState = {
      access_token: "live-tok",
      refresh_token: "rt-1",
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    await writeTokens(state, store);

    const tok = await getValidAccessToken({ store });
    expect(tok).toBe("live-tok");
  });

  it("falls back to X_ACCESS_TOKEN env when no state file", async () => {
    process.env.X_ACCESS_TOKEN = "static-fallback";
    const tok = await getValidAccessToken({ store });
    expect(tok).toBe("static-fallback");
  });

  it("throws a helpful error when no token configured at all", async () => {
    await expect(getValidAccessToken({ store })).rejects.toThrow(
      /No X access token is configured/,
    );
  });

  it("refreshes when state expires within buffer and persists rotated tokens", async () => {
    process.env.X_CLIENT_ID = "cid";
    process.env.X_CLIENT_SECRET = "csec";
    const expiringState: XTokenState = {
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: new Date(Date.now() + 5_000).toISOString(),
    };
    await writeTokens(expiringState, store);

    const { fetch: stubFetch, calls } = makeStubFetch([
      {
        status: 200,
        body: {
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 7200,
          token_type: "bearer",
        },
      },
    ]);

    const refreshed = await refreshTokens(expiringState, {
      fetchImpl: stubFetch,
      store,
    });
    expect(refreshed.access_token).toBe("new-access");
    expect(refreshed.refresh_token).toBe("new-refresh");
    expect(new Date(refreshed.expires_at).getTime()).toBeGreaterThan(Date.now() + 7000_000);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.x.com/2/oauth2/token");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].authorization).toBe(
      `Basic ${Buffer.from("cid:csec").toString("base64")}`,
    );
    expect(calls[0].body).toContain("grant_type=refresh_token");
    expect(calls[0].body).toContain("refresh_token=old-refresh");

    const persisted = await readTokens(store);
    expect(persisted).not.toBeNull();
    if (!persisted) throw new Error("Missing persisted token state");
    expect(persisted.access_token).toBe("new-access");
    expect(persisted.refresh_token).toBe("new-refresh");
  });

  it("keeps the existing refresh_token if X omits one in the response", async () => {
    process.env.X_CLIENT_ID = "cid";
    process.env.X_CLIENT_SECRET = "csec";
    const state: XTokenState = {
      access_token: "old",
      refresh_token: "keep-me",
      expires_at: new Date(Date.now() + 1_000).toISOString(),
    };
    await writeTokens(state, store);
    const { fetch: stubFetch } = makeStubFetch([
      {
        status: 200,
        body: { access_token: "next", expires_in: 7200 },
      },
    ]);
    const refreshed = await refreshTokens(state, {
      fetchImpl: stubFetch,
      store,
    });
    expect(refreshed.refresh_token).toBe("keep-me");
  });

  it("refreshTokens throws a helpful error when X returns non-2xx", async () => {
    process.env.X_CLIENT_ID = "cid";
    process.env.X_CLIENT_SECRET = "csec";
    const state: XTokenState = {
      access_token: "old",
      refresh_token: "rt",
      expires_at: new Date().toISOString(),
    };
    const { fetch: stubFetch } = makeStubFetch([
      { status: 400, body: { error: "invalid_grant" } },
    ]);
    await expect(refreshTokens(state, {
      fetchImpl: stubFetch,
      store,
    })).rejects.toThrow(
      /token refresh failed.*invalid_grant/i,
    );
  });

  it("refreshTokens demands client credentials", async () => {
    const state: XTokenState = {
      access_token: "old",
      refresh_token: "rt",
      expires_at: new Date().toISOString(),
    };
    await expect(refreshTokens(state, { store })).rejects.toThrow(
      /X_CLIENT_ID\/X_CLIENT_SECRET/,
    );
  });

  it("readTokens returns null on malformed runtime state", async () => {
    await store.set("x.oauth.tokens", {
      access_token: 42,
    });
    expect(await readTokens(store)).toBeNull();
  });
});
