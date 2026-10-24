import http from "node:http";
import crypto from "node:crypto";
import { createXOAuth } from "../usage-providers.js";
import { type XOAuthTokenResponse } from "@apicity/x";
import { appState } from "../app-state.js";
import { readTokens, writeTokens, type XTokenStore } from "./x-tokens.js";
import {
  clearXAccount,
  fetchXAccount,
  resolveXAccount,
  xPostMaxCharacters,
  type XSubscriptionType,
} from "./account.js";

const REDIRECT = "http://127.0.0.1:8765/callback";
const PORT = 8765;
const SCOPES = [
  "tweet.read",
  "tweet.write",
  "media.write",
  "users.read",
  "offline.access",
].join(" ");
const FLOW_TIMEOUT_MS = 5 * 60_000;

type FlowStatus = "pending" | "succeeded" | "failed";

interface FlowState {
  verifier: string;
  stateParam: string;
  authorizeUrl: string;
  startedAt: number;
  status: FlowStatus;
  error?: string;
  server: http.Server;
  timeoutHandle: NodeJS.Timeout;
}

let activeFlow: FlowState | null = null;

function disposeFlow(flow: FlowState): void {
  clearTimeout(flow.timeoutHandle);
  try {
    flow.server.close();
  } catch {
    /* ignore */
  }
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>X connected</title>
<style>body{background:#0a0a0a;color:#e6f7ff;font:14px/1.5 -apple-system,system-ui,monospace;display:grid;place-items:center;height:100vh;margin:0}div{padding:24px 28px;border:1px solid #1f3550;border-radius:8px;background:#0d1623}h1{margin:0 0 8px;font-size:15px;color:#7ec7ff;letter-spacing:.08em;text-transform:uppercase}p{margin:0;color:#9fbedb}</style>
</head><body><div><h1>X connected</h1><p>Token saved. You can close this tab and return to the app.</p></div></body></html>`;

function buildErrorHtml(message: string): string {
  const safe = message.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>X connect failed</title>
<style>body{background:#0a0a0a;color:#fee;font:14px/1.5 -apple-system,system-ui,monospace;display:grid;place-items:center;height:100vh;margin:0}div{padding:24px 28px;border:1px solid #5a1f1f;border-radius:8px;background:#1d0d0d;max-width:520px}h1{margin:0 0 8px;font-size:15px;color:#ff9f9f;letter-spacing:.08em;text-transform:uppercase}p{margin:0;color:#dba}</style>
</head><body><div><h1>X connect failed</h1><p>${safe}</p></div></body></html>`;
}

async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
  verifier: string,
): Promise<XOAuthTokenResponse> {
  const oauth = createXOAuth({ clientId, clientSecret });
  return oauth.post.v2.oauth2.token({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
}

/**
 * Cache which account the fresh tokens belong to and its subscription tier.
 * A failed lookup clears the cache so a previous account's tier cannot leak
 * onto the new one; the status call retries the lookup later.
 */
async function rememberConnectedAccount(store: XTokenStore): Promise<void> {
  try {
    await fetchXAccount({ store });
  } catch {
    await clearXAccount(store);
  }
}

export async function startOAuthFlow(
  store: XTokenStore = appState,
): Promise<{ authorize_url: string }> {
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "X_CLIENT_ID and X_CLIENT_SECRET must be set in .env before connecting. "
        + "Get them from console.x.com → your app → OAuth 2.0 settings.",
    );
  }

  if (activeFlow) {
    disposeFlow(activeFlow);
    activeFlow = null;
  }

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  const stateParam = crypto.randomBytes(16).toString("hex");

  const authURL = new URL("https://x.com/i/oauth2/authorize");
  authURL.searchParams.set("response_type", "code");
  authURL.searchParams.set("client_id", clientId);
  authURL.searchParams.set("redirect_uri", REDIRECT);
  authURL.searchParams.set("scope", SCOPES);
  authURL.searchParams.set("state", stateParam);
  authURL.searchParams.set("code_challenge", challenge);
  authURL.searchParams.set("code_challenge_method", "S256");

  const server = http.createServer();
  const flow: FlowState = {
    verifier,
    stateParam,
    authorizeUrl: authURL.toString(),
    startedAt: Date.now(),
    status: "pending",
    server,
    timeoutHandle: setTimeout(() => {
      if (flow.status === "pending") {
        flow.status = "failed";
        flow.error = "OAuth flow timed out after 5 minutes";
        try {
          server.close();
        } catch {
          /* ignore */
        }
      }
    }, FLOW_TIMEOUT_MS),
  };

  server.on("request", async (req, res) => {
    if (!req.url) {
      res.writeHead(400).end();
      return;
    }
    const url = new URL(req.url, REDIRECT);
    if (!url.pathname.startsWith("/callback")) {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    if (!code || returnedState !== flow.stateParam) {
      flow.status = "failed";
      flow.error = "OAuth callback rejected: invalid state or missing code";
      res
        .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        .end(buildErrorHtml(flow.error));
      disposeFlow(flow);
      return;
    }
    try {
      const tok = await exchangeCodeForTokens(
        clientId,
        clientSecret,
        code,
        flow.verifier,
      );
      if (!tok.refresh_token) {
        throw new Error(
          "X did not return a refresh token — check that the offline.access scope is granted.",
        );
      }
      await writeTokens(
        {
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
        },
        store,
      );
      await rememberConnectedAccount(store);
      flow.status = "succeeded";
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(SUCCESS_HTML);
    } catch (err) {
      flow.status = "failed";
      flow.error = err instanceof Error ? err.message : String(err);
      res
        .writeHead(500, { "Content-Type": "text/html; charset=utf-8" })
        .end(buildErrorHtml(flow.error));
    } finally {
      disposeFlow(flow);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => {
      clearTimeout(flow.timeoutHandle);
      reject(
        new Error(
          `Could not start local listener on 127.0.0.1:${PORT}: ${err.message}. `
            + "Close any other process using that port and try again.",
        ),
      );
    };
    server.once("error", onErr);
    server.listen(PORT, "127.0.0.1", () => {
      server.off("error", onErr);
      resolve();
    });
  });

  activeFlow = flow;
  return { authorize_url: flow.authorizeUrl };
}

interface OAuthFlowAccount {
  username: string;
  subscription_type: XSubscriptionType;
}

interface OAuthFlowStatus {
  connected: boolean;
  pending: boolean;
  has_credentials: boolean;
  error?: string;
  expires_at?: string;
  account: OAuthFlowAccount | null;
  post_max_characters: number;
}

interface OAuthFlowStatusOptions {
  /** Re-read the account from X instead of trusting the cached tier. */
  refreshAccount?: boolean;
  fetchImpl?: typeof fetch;
}

export async function getOAuthFlowStatus(
  store: XTokenStore = appState,
  options: OAuthFlowStatusOptions = {},
): Promise<OAuthFlowStatus> {
  const tokens = await readTokens(store);
  const connected = tokens !== null;
  const pending = activeFlow?.status === "pending";
  const error
    = !pending && activeFlow?.status === "failed" ? activeFlow.error : undefined;
  const has_credentials = Boolean(
    process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET,
  );
  const account = connected && !pending
    ? await resolveXAccount({
      store,
      fetchImpl: options.fetchImpl,
      refresh: options.refreshAccount,
    })
    : null;
  return {
    connected,
    pending,
    has_credentials,
    error,
    expires_at: tokens?.expires_at,
    account: account
      ? { username: account.username, subscription_type: account.subscription_type }
      : null,
    post_max_characters: xPostMaxCharacters(account?.subscription_type ?? null),
  };
}
