/**
 * In-memory live-progress registry for the plan_visualization analysis.
 *
 * The plan job streams the vision model's output here as it arrives; the
 * `read_plan_progress` MCP tool reads it so the client can render the analysis
 * "live" while generating. Writer (job runner) and reader (tool handler) run in
 * the same long-lived Express process (same place the `queue` singleton lives),
 * so a module-level Map is shared between them.
 *
 * This is a transient preview only — the authoritative plan is still the atomic
 * `.plan.json` write the job makes on completion. Nothing here is persisted, so
 * a server restart simply drops in-flight previews (the job's scene-arrival
 * poll on the client recovers the final result).
 */

export type PlanProgressStatus = "generating" | "done" | "failed";

export interface PlanProgress {
  status: PlanProgressStatus;
  text: string;
  updatedAt: number;
  error?: string;
}

// One in-flight (or recently finished) analysis per project — the plan is
// per-project and the analyze lease serializes runs, so projectSlug is the key.
const registry = new Map<string, PlanProgress>();

// Backstops against unbounded growth / leaked entries.
const MAX_ENTRIES = 64;
const FINALIZED_TTL_MS = 60_000;

function evictOverflow(): void {
  while (registry.size > MAX_ENTRIES) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
}

// Begin a fresh run, replacing any stale entry from a prior run for this project.
export function startPlanProgress(projectSlug: string): void {
  registry.set(projectSlug, { status: "generating", text: "", updatedAt: Date.now() });
  evictOverflow();
}

// Replace the streamed text so far. Only updates an in-flight entry, so a late
// delta from an aborted/superseded run can't resurrect stale streaming text.
export function updatePlanProgress(projectSlug: string, text: string): void {
  const current = registry.get(projectSlug);
  if (!current || current.status !== "generating") return;
  current.text = text;
  current.updatedAt = Date.now();
}

// Mark the run terminal and schedule eviction after a short grace window so a
// polling client can read the final state once before it's dropped.
export function finishPlanProgress(
  projectSlug: string,
  status: "done" | "failed",
  error?: string,
): void {
  const current = registry.get(projectSlug);
  if (!current) return;
  current.status = status;
  current.updatedAt = Date.now();
  if (error) current.error = error;
  const timer = setTimeout(() => {
    const latest = registry.get(projectSlug);
    // Don't evict if a newer run has since started for this project.
    if (latest && latest.status !== "generating") registry.delete(projectSlug);
  }, FINALIZED_TTL_MS);
  timer.unref?.();
}

export function getPlanProgress(projectSlug: string): PlanProgress | null {
  return registry.get(projectSlug) ?? null;
}
