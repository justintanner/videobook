import { createXOAuth, XError, type XOAuthTokenResponse } from "@apicity/x";
import { appState, type ApplicationStateStore } from "../app-state.js";

const REFRESH_BUFFER_MS = 60_000;
const SETTINGS_KEY = "x.oauth.tokens";

export interface XTokenState {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

export type XTokenStore = ApplicationStateStore;

let writeChain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

export async function readTokens(
  store: XTokenStore = appState,
): Promise<XTokenState | null> {
  const parsed = await store.get<Partial<XTokenState>>(SETTINGS_KEY);
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
  store: XTokenStore = appState,
): Promise<void> {
  await serialize(() => store.set(SETTINGS_KEY, state));
}

function expiresWithin(state: XTokenState, ms: number): boolean {
  const expiresAt = new Date(state.expires_at).getTime();
  return Number.isNaN(expiresAt) || expiresAt - Date.now() < ms;
}

interface GetTokenOptions {
  fetchImpl?: typeof fetch;
  store?: XTokenStore;
}

export async function refreshTokens(
  state: XTokenState,
  options: GetTokenOptions = {},
): Promise<XTokenState> {
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("X token expired and X_CLIENT_ID/X_CLIENT_SECRET are not configured");
  }
  const oauth = createXOAuth({ clientId, clientSecret, fetch: options.fetchImpl ?? fetch });
  let body: XOAuthTokenResponse;
  try {
    body = await oauth.post.v2.oauth2.token({
      grant_type: "refresh_token",
      refresh_token: state.refresh_token,
    });
  } catch (error) {
    if (error instanceof XError) {
      const detail = error.body ? JSON.stringify(error.body) : error.message;
      throw new Error(`X token refresh failed (${error.status}): ${detail}`);
    }
    throw error;
  }
  const next: XTokenState = {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? state.refresh_token,
    expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(),
  };
  await writeTokens(next, options.store ?? appState);
  return next;
}

export async function getValidAccessToken(
  options: GetTokenOptions = {},
): Promise<string> {
  const store = options.store ?? appState;
  const state = await readTokens(store);
  if (state) {
    if (!expiresWithin(state, REFRESH_BUFFER_MS)) return state.access_token;
    return (await refreshTokens(state, { fetchImpl: options.fetchImpl, store })).access_token;
  }
  const fallback = process.env.X_ACCESS_TOKEN;
  if (fallback) return fallback;
  throw new Error("No X access token is configured. Set X_ACCESS_TOKEN or connect X OAuth.");
}
