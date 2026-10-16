import { z } from "zod";
import { dropboxStatus, startDropboxConnect } from "../posts/dropbox-auth.js";
import { icloudStatus } from "../posts/icloud-drive.js";
import { getOAuthFlowStatus, startOAuthFlow } from "../x/oauth-flow.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toolError(error: unknown): ToolResult {
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

async function startConnection(service: unknown): Promise<unknown> {
  if (service === "x") return { authorize_url: (await startOAuthFlow()).authorize_url };
  return startDropboxConnect();
}

async function readStatus(service: unknown, refreshAccount: boolean): Promise<unknown> {
  if (service === "x") return getOAuthFlowStatus(undefined, { refreshAccount });
  return service === "dropbox" ? dropboxStatus() : icloudStatus();
}

export function connectServiceDef(): ToolDef {
  return {
    name: "connect_service",
    description: "Start connecting an X or Dropbox account and return the authorize_url to open; poll service_status until connected. Credentials stay in application state, outside books.",
    scope: "global",
    schema: { service: z.enum(["x", "dropbox"]) },
    handler: async (args) => {
      try { return textResult(await startConnection(args.service)); }
      catch (error) { return toolError(error); }
    },
  };
}

export function serviceStatusDef(): ToolDef {
  return {
    name: "service_status",
    description: "Read X, Dropbox or iCloud Drive delivery status without exposing credentials. X adds the account, its subscription tier and post_max_characters; iCloud adds the Videobook root folder and whether it is shared with the phones.",
    scope: "global",
    schema: {
      service: z.enum(["x", "dropbox", "icloud"]),
      refresh_account: z.boolean().optional().describe("X only: re-read the username and subscription tier instead of the cached copy"),
    },
    handler: async (args) => {
      try { return textResult(await readStatus(args.service, args.refresh_account === true)); }
      catch (error) { return toolError(error); }
    },
  };
}
