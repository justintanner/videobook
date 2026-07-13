import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { emptyNotebookDefinition, isNotebookSidecar } from "../notebook-store.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { buildAssetList } from "./sync.js";

export function isMissingNotebookError(error: { code?: string; message: string }): boolean {
  return error.code === "NOT_FOUND" || error.message.includes("File not found");
}

function missingNotebookResponse(legacy = false): Record<string, unknown> {
  return {
    exists: false,
    ...(legacy ? { legacy: true } : {}),
    definition: emptyNotebookDefinition(),
    captures: [],
    capture_layout: {},
  };
}

export function readNotebookDef(fs: VideocityFs): ToolDef {
  return {
    name: "read_notebook",
    description: "Read a Notebook sidecar (nb-*/.notebook.json).",
    schema: {
      project_slug: z.string().describe("Project slug"),
      notebook_id: z.string().describe("Asset ID of the notebook (e.g. nb-123)"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { project_slug, notebook_id } = args as { project_slug: string; notebook_id: string; };
      const project = await fs.getProject(project_slug);
      if (!project.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: project.error.message }],
        };
      }

      const layoutResult = await fs.readMetadata<Record<string, { x: number; y: number }>>(
        notebook_id,
        "capture-layout",
        project_slug
      );
      const capture_layout = layoutResult.ok ? layoutResult.value : {};

      const actions = await fs.getActionLog({ limit: 5000 }, project_slug);
      const assets = await buildAssetList(fs, project_slug);
      const assetMap = new Map(assets.map((a) => [a.id, a]));

      const jobErrorsByAssetId = new Map<string, string>();
      for (const a of actions) {
        if (a.action === "job-error") {
          const payload = a.payload as Record<string, unknown> | undefined;
          if (payload && typeof payload.asset_id === "string") {
            jobErrorsByAssetId.set(
              payload.asset_id,
              typeof payload.error === "string" ? payload.error : "Job failed"
            );
          }
        }
      }

      const captures: Record<string, unknown>[] = [];
      for (const a of actions) {
        const payload = a.payload as {
          _error?: string;
          _notebook_capture?: {
            notebook_id: string;
            category: string;
            provider?: string;
            inputs?: Record<string, unknown>;
            outcome?: {
              assetIds?: string[];
              error?: string;
            };
          };
        } | undefined;
        if (!payload || !payload._notebook_capture) continue;
        const capture = payload._notebook_capture;
        if (capture.notebook_id !== notebook_id) continue;

        const baseNode = {
          action_hash: a.hash,
          date: a.date,
          category: capture.category,
          provider: capture.provider || "unknown",
          inputs: capture.inputs || {},
        };

        const assetIds = Array.isArray(capture.outcome?.assetIds) ? capture.outcome.assetIds : [];

        if (assetIds.length === 0) {
          captures.push({
            id: `${a.hash}-0`,
            ...baseNode,
            status: payload._error ? "failed" : "missing",
            error: payload._error || capture.outcome?.error,
          });
        } else {
          assetIds.forEach((assetId: string, index: number) => {
            let status = "missing";
            let error = undefined;

            if (payload._error) {
              status = "failed";
              error = payload._error;
            } else if (jobErrorsByAssetId.has(assetId)) {
              status = "failed";
              error = jobErrorsByAssetId.get(assetId);
            } else {
              const asset = assetMap.get(assetId);
              if (asset) {
                status = asset.status;
              } else {
                status = "deleted";
              }
            }

            captures.push({
              id: `${a.hash}-${index}`,
              ...baseNode,
              assetId,
              status,
              error,
            });
          });
        }
      }

      const result = await fs.readFile(notebook_id, ".notebook.json", project_slug);
      if (!result.ok) {
        if (isMissingNotebookError(result.error)) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ...missingNotebookResponse(), captures, capture_layout }) }],
          };
        }
        return {
          isError: true,
          content: [{ type: "text", text: result.error.message }],
        };
      }

      let sidecar: unknown;
      try {
        sidecar = JSON.parse(Buffer.from(result.value).toString("utf-8"));
      } catch {
        return {
          content: [{ type: "text", text: JSON.stringify({ ...missingNotebookResponse(true), captures, capture_layout }) }],
        };
      }
      if (!isNotebookSidecar(sidecar)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ...missingNotebookResponse(true), captures, capture_layout }) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ exists: true, definition: sidecar.definition, captures, capture_layout }) }],
      };
    },
  };
}
