import type { ActionLogEntry, GitCommit, VideocityFs } from "videobook-engine";
import { z } from "zod";
import { isExcludedAction } from "./activity-policy.js";
import type { ToolDef } from "./tool-def.js";

type ActivitySource = "action" | "snapshot";
type ActivityCategory =
  | "generate"
  | "render"
  | "upload"
  | "transcribe"
  | "trim"
  | "edit"
  | "create"
  | "delete"
  | "fail"
  | "rewind"
  | "other";

interface ProjectActivityEntry {
  hash: string;
  action: string;
  title: string;
  category: ActivityCategory;
  source: ActivitySource;
  date: string;
  rewindable: boolean;
  payload?: string | Record<string, unknown>;
  assetId?: string;
}

function hasError(payload: string | Record<string, unknown>): boolean {
  return typeof payload === "object" && payload !== null && "_error" in payload;
}

function extractAssetIdFromPayload(payload: string | Record<string, unknown>): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  return (
    (payload.asset_id as string | undefined) ??
    (payload.assetId as string | undefined) ??
    (payload.source_asset_id as string | undefined) ??
    (payload.vid_asset_id as string | undefined) ??
    (payload.img_asset_id as string | undefined)
  );
}

function normalizeActionName(action: string): string {
  return action.replace(/^tool-/, "").replace(/-/g, " ");
}

function categorize(action: string, payload?: string | Record<string, unknown>): ActivityCategory {
  if (action === "job-error" || (payload !== undefined && hasError(payload))) return "fail";
  if (action.includes("rewind") || action.includes("restore")) return "rewind";
  if (
    action.includes("generate") ||
    action.includes("grok") ||
    action.includes("kling") ||
    action.includes("seedance") ||
    action.includes("seedream") ||
    action.includes("wan27") ||
    action.includes("nano-banana") ||
    action.includes("gpt-image")
  ) return "generate";
  if (action.includes("render")) return "render";
  if (action.includes("upload") || action.includes("download")) return "upload";
  if (action.includes("transcribe") || action.includes("isolate")) return "transcribe";
  if (action.includes("trim") || action.includes("cut") || action.includes("split")) return "trim";
  if (action.includes("create") || action === "Initialize project") return "create";
  if (action.includes("delete")) return "delete";
  if (
    action.includes("edit") ||
    action.includes("write") ||
    action.includes("assign") ||
    action.includes("clear") ||
    action.includes("speed") ||
    action.includes("reverse") ||
    action.includes("crop") ||
    action.includes("splice") ||
    action.includes("audio") ||
    action.includes("watermark") ||
    action.includes("pin")
  ) return "edit";
  return "other";
}

function actionEntry(entry: ActionLogEntry): ProjectActivityEntry | null {
  if (isExcludedAction(entry.action)) return null;
  const assetId = extractAssetIdFromPayload(entry.payload);
  return {
    hash: entry.hash,
    action: entry.action,
    title: normalizeActionName(entry.action),
    category: categorize(entry.action, entry.payload),
    source: "action",
    date: entry.date,
    rewindable: true,
    payload: entry.payload,
    ...(assetId ? { assetId } : {}),
  };
}

function snapshotEntry(commit: GitCommit): ProjectActivityEntry | null {
  if (commit.message.startsWith("[action:")) return null;
  const assetMatch = commit.message.match(/^\[([^\]]+)\]\s+(.+)$/);
  const projectMatch = commit.message.match(/^(.+): project$/);
  const action = assetMatch?.[2] ?? projectMatch?.[1] ?? commit.message;
  // Engine auto-commits every file write as a "write*" snapshot — per-file
  // mechanics, not user-level events; they flood the feed during pipelines.
  if (/^write/i.test(action)) return null;
  const assetId = assetMatch?.[1];
  return {
    hash: commit.hash,
    action,
    title: assetId ? `${action.replace(/_/g, " ")} ${assetId}` : action.replace(/_/g, " "),
    category: categorize(action),
    source: "snapshot",
    date: commit.date,
    rewindable: true,
    ...(assetId ? { assetId } : {}),
  };
}

function byNewest(a: ProjectActivityEntry, b: ProjectActivityEntry): number {
  return new Date(b.date).getTime() - new Date(a.date).getTime();
}

export function projectActivityDef(fs: VideocityFs): ToolDef {
  return {
    name: "project_activity",
    description: "Get project-changing activity and rewind snapshots for a project",
    schema: {
      project_slug: z.string().describe("Project slug"),
      limit: z.number().optional().describe("Max entries to return (default 50)"),
    },
    handler: async (args) => {
      const { project_slug, limit } = args as { project_slug: string; limit?: number };
      const max = limit ?? 50;
      const fetchLimit = Math.max(max * 4, 100);
      const [actions, history] = await Promise.all([
        fs.getActionLog({ limit: fetchLimit }, project_slug),
        fs.getHistory(project_slug, fetchLimit),
      ]);
      const merged = new Map<string, ProjectActivityEntry>();
      for (const entry of actions) {
        const formatted = actionEntry(entry);
        if (formatted) merged.set(formatted.hash, formatted);
      }
      for (const commit of history) {
        if (merged.has(commit.hash)) continue;
        const formatted = snapshotEntry(commit);
        if (formatted) merged.set(formatted.hash, formatted);
      }
      const entries = [...merged.values()].sort(byNewest).slice(0, max);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(entries),
        }],
      };
    },
  };
}
