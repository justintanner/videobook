import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createDropbox } from "@apicity/dropbox";
import type { DropboxProvider } from "@apicity/dropbox";
import { appState } from "../app-state.js";

const KEY = "dropbox.oauth.tokens";
const REDIRECT = "http://127.0.0.1:8766/callback";
interface Tokens { accessToken: string; refreshToken: string; expiresAt: string }
let pending = false;
let lastError: string | null = null;
let closeFlow: (() => void) | null = null;
let refreshing: Promise<DropboxProvider> | null = null;

function oauthClient() {
  const clientId = process.env.DROPBOX_CLIENT_ID;
  if (!clientId) throw new Error("Set DROPBOX_CLIENT_ID to your Dropbox app key before connecting");
  return createDropbox({ clientId, clientSecret: process.env.DROPBOX_CLIENT_SECRET });
}

export async function dropboxClient(): Promise<DropboxProvider> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const tokens = await appState.get<Tokens>(KEY);
    if (!tokens) throw new Error("Connect Dropbox in Settings before uploading");
    if (new Date(tokens.expiresAt).getTime() > Date.now() + 60_000) return createDropbox({ oauthToken: tokens.accessToken });
    const refreshed = await oauthClient().oauth2.token({ grant_type: "refresh_token", refresh_token: tokens.refreshToken });
    await appState.set<Tokens>(KEY, { accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token ?? tokens.refreshToken, expiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString() });
    return createDropbox({ oauthToken: refreshed.access_token });
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

export async function dropboxStatus() {
  const tokens = await appState.get<Tokens>(KEY);
  return { connected: Boolean(tokens), pending, has_credentials: Boolean(process.env.DROPBOX_CLIENT_ID), error: lastError, redirect_uri: REDIRECT };
}

export async function startDropboxConnect(): Promise<{ authorize_url: string }> {
  const client = oauthClient();
  if (closeFlow) throw new Error("Dropbox connection is already in progress. Complete it in the browser first.");
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const url = new URL("https://www.dropbox.com/oauth2/authorize");
  url.search = new URLSearchParams({ client_id: process.env.DROPBOX_CLIENT_ID!, response_type: "code", redirect_uri: REDIRECT, token_access_type: "offline", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state }).toString();
  const server = createServer((req, res) => {
    const callback = new URL(req.url ?? "/", REDIRECT);
    if (callback.pathname !== "/callback") { res.writeHead(404).end(); return; }
    if (callback.searchParams.get("state") !== state || !callback.searchParams.get("code")) { res.writeHead(400).end("Invalid authorization callback"); return; }
    void (async () => {
      try {
        const result = await client.oauth2.token({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: REDIRECT, code_verifier: verifier });
        if (closeFlow !== closeCurrent) { res.writeHead(400).end("Authorization expired. Connect again from Videobook."); return; }
        if (!result.refresh_token) throw new Error("Dropbox did not grant offline access");
        await appState.set<Tokens>(KEY, { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: new Date(Date.now() + result.expires_in * 1000).toISOString() });
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Dropbox connected. Return to Videobook.");
      } catch {
        lastError = "Dropbox authorization failed. Try connecting again.";
        res.writeHead(400).end(lastError);
      } finally { closeCurrent(); }
    })();
  });
  const timeout = setTimeout(() => { lastError = "Dropbox connection timed out"; closeCurrent(); }, 5 * 60_000);
  timeout.unref();
  const closeCurrent = () => { clearTimeout(timeout); server.close(); if (closeFlow === closeCurrent) { pending = false; closeFlow = null; } };
  closeFlow = closeCurrent;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(8766, "127.0.0.1", resolve); }).catch((error: unknown) => { closeCurrent(); throw error; });
  pending = true;
  lastError = null;
  return { authorize_url: url.toString() };
}
