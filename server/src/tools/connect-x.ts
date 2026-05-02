import { getOAuthFlowStatus, startOAuthFlow } from "../x/oauth-flow.js";
import type { ToolDef } from "./tool-def.js";

export function xConnectStartDef(): ToolDef {
  return {
    name: "x_connect_start",
    description:
      "Begin the X (Twitter) OAuth 2.0 user-context login flow. Spawns a local listener on 127.0.0.1:8765 and returns an authorize_url the client should open. After the user approves in the browser, the server captures the callback, exchanges the code, and persists refreshable tokens to ~/.clipfirst/x-tokens.json.",
    schema: {},
    handler: async () => {
      try {
        const result = await startOAuthFlow();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ authorize_url: result.authorize_url }),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true as const,
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : String(err),
            },
          ],
        };
      }
    },
  };
}

export function xConnectStatusDef(): ToolDef {
  return {
    name: "x_connect_status",
    description:
      "Report the current X login state. Returns { connected, pending, has_credentials, error?, expires_at? } so the client can poll while the user authorizes in the browser.",
    schema: {},
    handler: async () => {
      const status = await getOAuthFlowStatus();
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(status) },
        ],
      };
    },
  };
}
