/**
 * X OAuth 2.0 token state management.
 *
 * X user-context access tokens expire after 2 hours. To keep scheduled posts
 * working hours or days out, we persist the refresh token alongside the
 * access token and refresh proactively before each call when expiry is near.
 *
 * Two operating modes:
 *   1. OAuth (recommended): refreshable token state lives in the engine's
 *      unversioned runtime settings.
 *   2. Static token: only X_ACCESS_TOKEN is set in .env.
 */

import { createXOAuth, XError, type XOAuthTokenResponse } from "@apicity/x";
import type { Engine } from "videobook-engine";
import { fs as defaultEngine } from "../fs.js";

const REFRESH_BUFFER_MS = 60_000;
const SETTINGS_KEY = "x.oauth.tokens";

export interface XTokenState {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

export type XTokenStore = Pick<Engine, "settings">;

let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

export async function readTokens(
  engine: XTokenStore = defaultEngine,
): Promise<XTokenState | null> {
  const parsed = engine.settings.get<Partial<XTokenState>>(SETTINGS_KEY);
  if (
    parsed
    && typeof parsed.access_token === "string"
    && typeof parsed.refresh_token === "string"
    && typeof parsed.expires_at === "string"
  ) {
    return parsed as XTokenState;
  }
  return null;
}

export async function writeTokens(
  state: XTokenState,
  engine: XTokenStore = defaultEngine,
): Promise<void> {
  await serialize(async () => {
    const written = engine.settings.set(SETTINGS_KEY, state);
    if (!written.ok) throw new Error(written.error.message);
  });
}

function expiresWithin(state: XTokenState, ms: number): boolean {
  const expiresAt = new Date(state.expires_at).getTime();
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - Date.now() < ms;
}

export async function refreshTokens(
  state: XTokenState,
  options: GetTokenOptions = {},
): Promise<XTokenState> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const engine = options.engine ?? defaultEngine;
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "X token expired and X_CLIENT_ID/X_CLIENT_SECRET are not set. "
      + "Run x_connect_start or refresh manually.",
    );
  }
  const oauth = createXOAuth({ clientId, clientSecret, fetch: fetchImpl });
  let body: XOAuthTokenResponse;
  try {
    body = await oauth.post.v2.oauth2.token({
      grant_type: "refresh_token",
      refresh_token: state.refresh_token,
    });
  } catch (err) {
    if (err instanceof XError) {
      const detail = err.body ? JSON.stringify(err.body) : err.message;
      throw new Error(`X token refresh failed (${err.status}): ${detail}`);
    }
    throw err;
  }
  const next: XTokenState = {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? state.refresh_token,
    expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(),
  };
  await writeTokens(next, engine);
  return next;
}

export interface GetTokenOptions {
  fetchImpl?: typeof fetch;
  engine?: XTokenStore;
}

export async function getValidAccessToken(
  opts: GetTokenOptions = {},
): Promise<string> {
  const engine = opts.engine ?? defaultEngine;
  const state = await readTokens(engine);
  if (state) {
    if (!expiresWithin(state, REFRESH_BUFFER_MS)) {
      return state.access_token;
    }
    const refreshed = await refreshTokens(state, {
      fetchImpl: opts.fetchImpl,
      engine,
    });
    return refreshed.access_token;
  }
  const fallback = process.env.X_ACCESS_TOKEN;
  if (fallback && fallback.length > 0) return fallback;
  throw new Error(
    "No X access token available. Set X_ACCESS_TOKEN in .env (manual, "
    + "expires in 2h) or run x_connect_start to enable "
    + "auto-refreshed tokens. See node_modules/@apicity/x/README.md.",
  );
}
