#!/usr/bin/env node
/**
 * Mint an X (Twitter) OAuth 2.0 user-context access token + refresh token,
 * and write them to ~/.clipfirst/x-tokens.json (override via X_TOKENS_PATH)
 * so the running server picks them up automatically and refreshes on its own.
 *
 * Adapted from @apicity/x README. Run once after configuring your X app:
 *
 *   X_CLIENT_ID=... X_CLIENT_SECRET=... node scripts/mint-x-token.mjs
 *
 * App requirements (see node_modules/@apicity/x/README.md for the full guide):
 *   - Pay-Per-Use project on console.x.com (the legacy Free project is rejected)
 *   - User authentication: Web App / Automated App or Bot
 *   - Permissions: Read and write
 *   - Callback URI: http://127.0.0.1:8765/callback
 *   - Billing → Credits loaded ($5+; ~$0.015 per post)
 */
import http from "node:http";
import crypto from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CLIENT_ID = process.env.X_CLIENT_ID;
const CLIENT_SECRET = process.env.X_CLIENT_SECRET;
const REDIRECT = "http://127.0.0.1:8765/callback";
const SCOPES = [
  "tweet.read",
  "tweet.write",
  "media.write",
  "users.read",
  "offline.access",
].join(" ");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set X_CLIENT_ID and X_CLIENT_SECRET (see .env.example).");
  process.exit(1);
}

const STATE_PATH =
  process.env.X_TOKENS_PATH ?? join(homedir(), ".clipfirst", "x-tokens.json");

const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto
  .createHash("sha256")
  .update(verifier)
  .digest("base64url");
const state = crypto.randomBytes(16).toString("hex");

const authURL = new URL("https://x.com/i/oauth2/authorize");
authURL.searchParams.set("response_type", "code");
authURL.searchParams.set("client_id", CLIENT_ID);
authURL.searchParams.set("redirect_uri", REDIRECT);
authURL.searchParams.set("scope", SCOPES);
authURL.searchParams.set("state", state);
authURL.searchParams.set("code_challenge", challenge);
authURL.searchParams.set("code_challenge_method", "S256");

console.log('Open this URL and click "Authorize app":\n' + authURL.toString());

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  if (!url.pathname.startsWith("/callback")) {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.get("state") !== state) {
    res.writeHead(400).end("bad state");
    server.close();
    process.exit(1);
  }
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const tokenRes = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => "");
    res.writeHead(500).end("token exchange failed");
    console.error(`Token exchange failed (${tokenRes.status}): ${detail}`);
    server.close();
    process.exit(1);
  }

  const tok = await tokenRes.json();
  const next = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
  };
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, STATE_PATH);
  res.writeHead(200).end("Authorized — token saved. You can close this tab.");
  console.log(`Wrote tokens to ${STATE_PATH}`);
  console.log(`Access token expires at ${next.expires_at}.`);
  server.close();
});

server.listen(8765, "127.0.0.1");
