import { z } from "zod";
import { icloudStatus, postIcloudSyncStatus } from "../posts/icloud-drive.js";
import { resolveBookEngine } from "../queue.js";
import { getOAuthFlowStatus, startOAuthFlow } from "../x/oauth-flow.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toolError(error: unknown): ToolResult {
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

async function icloudPostStatus(args: Record<string, unknown>): Promise<unknown> {
  if (typeof args.book_id !== "string") throw new Error("book_id is required with post_cell_id");
  return postIcloudSyncStatus(await resolveBookEngine(args.book_id), String(args.post_cell_id));
}

async function readStatus(args: Record<string, unknown>): Promise<unknown> {
  if (args.service === "x") return getOAuthFlowStatus(undefined, { refreshAccount: args.refresh_account === true });
  return typeof args.post_cell_id === "string" ? icloudPostStatus(args) : icloudStatus();
}

export function connectServiceDef(): ToolDef {
  return {
    name: "connect_service",
    description: "Start connecting an X account and return the authorize_url to open; poll service_status until connected. Credentials stay in application state, outside books.",
    scope: "global",
    schema: { service: z.enum(["x"]) },
    handler: async () => {
      try { return textResult({ authorize_url: (await startOAuthFlow()).authorize_url }); }
      catch (error) { return toolError(error); }
    },
  };
}

export function serviceStatusDef(): ToolDef {
  return {
    name: "service_status",
    description: "Read X or iCloud Drive status without exposing credentials. X adds the account, its subscription tier and post_max_characters; iCloud adds the Videobook root folder and whether it is shared with the phones, or, with book_id and post_cell_id, whether that Post's clip and caption.txt finished uploading.",
    scope: "global",
    schema: {
      service: z.enum(["x", "icloud"]),
      refresh_account: z.boolean().optional().describe("X only: re-read the username and subscription tier instead of the cached copy"),
      book_id: z.string().optional().describe("iCloud only: book of post_cell_id"),
      post_cell_id: z.string().uuid().optional().describe("iCloud only: report this saved Post's upload progress"),
    },
    handler: async (args) => {
      try { return textResult(await readStatus(args)); }
      catch (error) { return toolError(error); }
    },
  };
}
