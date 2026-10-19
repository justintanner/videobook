#!/usr/bin/env node
/**
 * Mint an X (Twitter) OAuth 2.0 user-context access token + refresh token,
 * and write them to the application state file so the running server picks them
 * up automatically and refreshes on its own.
 *
 * Adapted from @apicity/x README. Run once after configuring your X app:
 *
 *   npm run mint:x-token
 *   (or X_CLIENT_ID=... X_CLIENT_SECRET=... node scripts/mint-x-token.mjs)
 *
 * The npm script runs under `op run --no-masking`: 1Password otherwise
 * conceals the client id inside the printed authorize URL. The helper also
 * opens that URL in the default browser, so the printed copy is a fallback.
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
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createXOAuth } from "@apicity/x";

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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataHome = process.env.VIDEOBOOK_HOME?.trim();
const statePath = process.env.VIDEOBOOK_APP_STATE_PATH?.trim()
  || (dataHome ? join(resolve(dataHome), "app-state.json") : join(root, "runtime", "app-state.json"));

async function writeTokens(next) {
  let state = { values: {} };
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.values && typeof parsed.values === "object") {
      state = parsed;
    }
  } catch {}
  state.values["x.oauth.tokens"] = next;
  // The tokens may belong to a different account: drop the cached account
  // tier so the server looks it up again on the next status check.
  delete state.values["x.account"];
  await mkdir(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), "utf8");
  await rename(temporary, statePath);
}

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

function openInBrowser(url) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The printed URL below is the fallback.
  }
}

console.log('Opening the X authorize page. If no browser tab appears, open this URL and click "Authorize app":\n' + authURL.toString());
openInBrowser(authURL.toString());

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
  const oauth = createXOAuth({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  let tok;
  try {
    tok = await oauth.post.v2.oauth2.token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
  } catch (err) {
    res.writeHead(500).end("token exchange failed");
    console.error(`Token exchange failed: ${err.message}`);
    server.close();
    process.exit(1);
  }
  const next = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
  };
  try {
    await writeTokens(next);
  } catch (err) {
    res.writeHead(500).end("token persistence failed");
    console.error(`Token persistence failed: ${err.message}`);
    server.close();
    process.exit(1);
  }
  res.writeHead(200).end("Authorized — token saved. You can close this tab.");
  console.log("Wrote tokens to the application state file.");
  console.log(`Access token expires at ${next.expires_at}.`);
  server.close();
});

server.listen(8765, "127.0.0.1");
