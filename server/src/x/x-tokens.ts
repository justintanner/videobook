/**
 * X OAuth 2.0 token state management.
 *
 * X user-context access tokens expire after 2 hours. To keep scheduled posts
 * working hours or days out, we persist the refresh token alongside the
 * access token and refresh proactively before each call when expiry is near.
 *
 * Two operating modes:
 *   1. OAuth (recommended): user runs `node scripts/mint-x-token.mjs` once.
 *      The script writes { access_token, refresh_token, expires_at } to the
 *      state file. We refresh automatically thereafter using X_CLIENT_ID +
 *      X_CLIENT_SECRET from .env.
 *   2. Static token: only X_ACCESS_TOKEN is set in .env. Works for ~2h after
 *      a manual mint, then fails until the user updates the env. No refresh.
 */

import { homedir } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const REFRESH_BUFFER_MS = 60_000;
const TOKEN_ENDPOINT = "https://api.x.com/2/oauth2/token";

export interface XTokenState {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

function stateFilePath(): string {
  return (
    process.env.X_TOKENS_PATH
    ?? join(homedir(), ".videocity", "x-tokens.json")
  );
}

let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

export async function readTokens(): Promise<XTokenState | null> {
  let raw: string;
  try {
    raw = await readFile(stateFilePath(), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<XTokenState>;
    if (
      typeof parsed.access_token === "string"
      && typeof parsed.refresh_token === "string"
      && typeof parsed.expires_at === "string"
    ) {
      return parsed as XTokenState;
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeTokens(state: XTokenState): Promise<void> {
  await serialize(async () => {
    const path = stateFilePath();
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, path);
  });
}

function expiresWithin(state: XTokenState, ms: number): boolean {
  const expiresAt = new Date(state.expires_at).getTime();
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - Date.now() < ms;
}

interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

export async function refreshTokens(
  state: XTokenState,
  fetchImpl: typeof fetch = fetch,
): Promise<XTokenState> {
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "X token expired and X_CLIENT_ID/X_CLIENT_SECRET are not set. "
      + "Re-run scripts/mint-x-token.mjs or refresh manually.",
    );
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: state.refresh_token,
    }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(`X token refresh failed (${res.status}): ${detail}`);
  }
  const body = (await res.json()) as RefreshResponse;
  const next: XTokenState = {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? state.refresh_token,
    expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(),
  };
  await writeTokens(next);
  return next;
}

export interface GetTokenOptions {
  fetchImpl?: typeof fetch;
}

export async function getValidAccessToken(
  opts: GetTokenOptions = {},
): Promise<string> {
  const state = await readTokens();
  if (state) {
    if (!expiresWithin(state, REFRESH_BUFFER_MS)) {
      return state.access_token;
    }
    const refreshed = await refreshTokens(state, opts.fetchImpl);
    return refreshed.access_token;
  }
  const fallback = process.env.X_ACCESS_TOKEN;
  if (fallback && fallback.length > 0) return fallback;
  throw new Error(
    "No X access token available. Set X_ACCESS_TOKEN in .env (manual, "
    + "expires in 2h) or run `node scripts/mint-x-token.mjs` to enable "
    + "auto-refreshed tokens. See node_modules/@apicity/x/README.md.",
  );
}
