import { z } from "zod";
import { getOAuthFlowStatus, startOAuthFlow } from "../x/oauth-flow.js";
import type { ToolDef } from "./tool-def.js";

export function xConnectStartDef(): ToolDef {
  return {
    name: "x_connect_start",
    description:
      "Begin the X (Twitter) OAuth 2.0 user-context login flow. Spawns a local listener on 127.0.0.1:8765 and returns the authorize_url. After approval, the server exchanges the code and persists refreshable tokens in the application credential store outside public book records.",
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
      "Report the current X login state. Returns { connected, pending, has_credentials, error?, expires_at?, account, post_max_characters } so the client can poll while the user authorizes in the browser. account carries the connected username and X subscription tier; post_max_characters is the post length that tier allows (280, or 25000 with any X Premium tier).",
    schema: {
      refresh_account: z
        .boolean()
        .optional()
        .describe("Re-read the connected account's username and subscription tier from X instead of the cached copy."),
    },
    handler: async (args) => {
      const { refresh_account } = args as { refresh_account?: boolean };
      const status = await getOAuthFlowStatus(undefined, {
        refreshAccount: refresh_account === true,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(status) },
        ],
      };
    },
  };
}
