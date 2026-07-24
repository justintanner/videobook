import type { BookAction, Engine } from "videobook-engine";
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

function actionEntry(entry: BookAction): ProjectActivityEntry | null {
  const action = entry.operation.replace(/^book:/, "");
  if (isExcludedAction(action) || /^write/i.test(action)) return null;
  const event = entry.events.at(-1);
  if (!event) return null;
  const payload = entry.details;
  const assetId =
    entry.targetArtifactId ??
    entry.outputArtifacts[0]?.id ??
    entry.inputArtifacts[0]?.id ??
    extractAssetIdFromPayload(payload);
  return {
    hash: event.revision,
    action,
    title: normalizeActionName(action),
    category: categorize(action, payload),
    source: "action",
    date: event.date,
    rewindable: true,
    payload,
    ...(assetId ? { assetId } : {}),
  };
}

function byNewest(a: ProjectActivityEntry, b: ProjectActivityEntry): number {
  return new Date(b.date).getTime() - new Date(a.date).getTime();
}

export function projectActivityDef(fs: Engine): ToolDef {
  return {
    name: "project_activity",
    description: "Read project-changing actions from the canonical project book",
    schema: {
      project_slug: z.string().describe("Project slug"),
      limit: z.number().optional().describe("Max entries to return (default 50)"),
    },
    handler: async (args) => {
      const { project_slug, limit } = args as { project_slug: string; limit?: number };
      const max = limit ?? 50;
      const fetchLimit = Math.max(max * 4, 100);
      const book = await fs.history.projectBook(project_slug, {
        limit: fetchLimit,
      });
      if (!book.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: book.error.message }],
        };
      }
      const entries = book.value.actions
        .map(actionEntry)
        .filter((entry): entry is ProjectActivityEntry => entry !== null)
        .sort(byNewest)
        .slice(0, max);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(entries),
        }],
      };
    },
  };
}
