import type { Engine, GenerationError, ArtifactView } from "videobook-engine";
import { z } from "zod";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { queue } from "../queue.js";

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

// assets-table statuses that count as "in progress" — a row sitting in one of
// these past its deadline is wedged, not legitimately working.
const STUCK_WORK_STATUSES: ReadonlySet<string> = new Set(["working", "pending"]);

interface BrokenAsset {
  asset_id: string;
  type: string;
  error: { message: string; fail_code: string | null; failed_at: number } | null;
}

interface StuckAsset {
  asset_id: string;
  type: string;
  work_status: string;
  deadline_at: number;
  minutes_overdue: number;
}

interface DoctorReport {
  book_id: string;
  total: number;
  healthy: number;
  broken: BrokenAsset[];
  stuck: StuckAsset[];
  hint?: string;
}

/**
 * Read-only health scan. Type-agnostic: it iterates every asset returned by
 * listAssets and asks the engine's own computeArtifactStatus (via getAssetStatus)
 * for each, so all seven asset types are covered without special-casing.
 */
async function diagnose(
  engine: Engine,
  bookId: string,
  onlyAssetId?: string,
): Promise<DoctorReport> {
  const all = await engine.artifacts.list();
  const assets = onlyAssetId ? all.filter((a) => a.artifactId === onlyAssetId) : all;

  const errorsRes = await engine.jobs.failures.findAll();
  const errorByAsset = new Map<string, GenerationError>();
  if (errorsRes.ok) for (const e of errorsRes.value) errorByAsset.set(e.artifactId, e);

  const workRes = await engine.jobs.artifactWork.list();
  const workByAsset = new Map<string, ArtifactView>();
  if (workRes.ok) for (const w of workRes.value) workByAsset.set(w.artifactId, w);

  const nowMs = Date.now();
  const broken: BrokenAsset[] = [];
  const stuck: StuckAsset[] = [];
  let healthy = 0;

  await Promise.all(
    assets.map(async (a) => {
      const statusRes = await engine.status.get(a.artifactId);
      const status = statusRes.ok ? statusRes.value : "error";
      const work = workByAsset.get(a.artifactId);

      if (status === "error") {
        const ge = errorByAsset.get(a.artifactId);
        broken.push({
          asset_id: a.artifactId,
          type: a.kind,
          error: ge
            ? { message: ge.message, fail_code: ge.failCode ?? null, failed_at: ge.failedAt }
            : null,
        });
      } else if (
        work &&
        STUCK_WORK_STATUSES.has(work.status) &&
        work.deadlineAt != null &&
        work.deadlineAt < nowMs
      ) {
        stuck.push({
          asset_id: a.artifactId,
          type: a.kind,
          work_status: work.status,
          deadline_at: work.deadlineAt,
          minutes_overdue: Math.round((nowMs - work.deadlineAt) / 60000),
        });
      } else {
        healthy += 1;
      }
    }),
  );

  const report: DoctorReport = {
    book_id: bookId,
    total: assets.length,
    healthy,
    broken,
    stuck,
  };
  if (broken.length > 0 || stuck.length > 0) {
    report.hint =
      "Re-run with { asset_id, fix: true } to restore a specific asset to its last usable state.";
  }
  return report;
}

export function doctorDef(engine: Engine): ToolDef {
  return {
    name: "doctor",
    description:
      "Diagnose the health of every asset in a project (all asset types: video, image, audio, " +
      "script, final, character, plan). Reports assets stuck in the error state and assets wedged " +
      "in-progress past their work deadline. Pass fix:true with an explicit asset_id to restore " +
      "that one asset to its last usable state before the current error — clears a stale error or " +
      "lease when the media is intact, otherwise restores the asset from Dolt history. A bare " +
      "fix:true scan never bulk-fixes; it just reports.",
    schema: {
      book_id: z.string().describe("Book id"),
      asset_id: z
        .string()
        .optional()
        .describe("Limit diagnosis to one asset by artifact id; REQUIRED when fix is true"),
      fix: z
        .boolean()
        .optional()
        .default(false)
        .describe("Restore the given asset_id to its last usable state. Requires asset_id."),
    },
    handler: async (args) => {
      const { book_id, asset_id, fix } = args as {
        book_id: string;
        asset_id?: string;
        fix?: boolean;
      };
      const assetId = asset_id?.replace(/^@/, "");

      if (fix) {
        if (!assetId) {
          return error(
            "doctor fix requires an explicit asset_id — it never bulk-fixes a project. " +
              "Run doctor without fix to see which assets need attention.",
          );
        }
        const jobId = `doctor-fix-${assetId}-${Date.now()}`;
        try {
          const result = await queue.enqueueAndWait(jobId, {
            type: "doctor_fix",
            bookId: book_id,
            assetId,
          });
          return ok(result);
        } catch (e) {
          return error(
            `doctor fix failed for ${assetId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      return ok(await diagnose(engine, book_id, assetId));
    },
  };
}
