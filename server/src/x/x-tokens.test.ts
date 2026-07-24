import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../fs.js";
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
  let tempDir: string;
  let fs: Engine;
  const originalEnv = {
    X_ACCESS_TOKEN: process.env.X_ACCESS_TOKEN,
    X_CLIENT_ID: process.env.X_CLIENT_ID,
    X_CLIENT_SECRET: process.env.X_CLIENT_SECRET,
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-xtok-"));
    fs = createEngineForTest(tempDir);
    delete process.env.X_ACCESS_TOKEN;
    delete process.env.X_CLIENT_ID;
    delete process.env.X_CLIENT_SECRET;
  });

  afterEach(async () => {
    if (originalEnv.X_ACCESS_TOKEN !== undefined) {
      process.env.X_ACCESS_TOKEN = originalEnv.X_ACCESS_TOKEN;
    }
    if (originalEnv.X_CLIENT_ID !== undefined) {
      process.env.X_CLIENT_ID = originalEnv.X_CLIENT_ID;
    }
    if (originalEnv.X_CLIENT_SECRET !== undefined) {
      process.env.X_CLIENT_SECRET = originalEnv.X_CLIENT_SECRET;
    }
    closeEngineForTest(tempDir, fs);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns access_token from Dolt runtime state when not near expiry", async () => {
    const state: XTokenState = {
      access_token: "live-tok",
      refresh_token: "rt-1",
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    await writeTokens(state, fs);

    const tok = await getValidAccessToken({ engine: fs });
    expect(tok).toBe("live-tok");
  });

  it("falls back to X_ACCESS_TOKEN env when no state file", async () => {
    process.env.X_ACCESS_TOKEN = "static-fallback";
    const tok = await getValidAccessToken({ engine: fs });
    expect(tok).toBe("static-fallback");
  });

  it("throws a helpful error when no token configured at all", async () => {
    await expect(getValidAccessToken({ engine: fs })).rejects.toThrow(
      /No X access token available/,
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
    await writeTokens(expiringState, fs);

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
      engine: fs,
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

    const persisted = await readTokens(fs);
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
    await writeTokens(state, fs);
    const { fetch: stubFetch } = makeStubFetch([
      {
        status: 200,
        body: { access_token: "next", expires_in: 7200 },
      },
    ]);
    const refreshed = await refreshTokens(state, {
      fetchImpl: stubFetch,
      engine: fs,
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
      engine: fs,
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
    await expect(refreshTokens(state, { engine: fs })).rejects.toThrow(
      /X_CLIENT_ID\/X_CLIENT_SECRET/,
    );
  });

  it("readTokens returns null on malformed runtime state", async () => {
    const result = fs.settings.set("x.oauth.tokens", {
      access_token: 42,
    });
    expect(result.ok).toBe(true);
    expect(await readTokens(fs)).toBeNull();
  });
});
