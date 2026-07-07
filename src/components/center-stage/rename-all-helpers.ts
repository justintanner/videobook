/**
 * Pure helpers for the RenameAllPanel UI: building editable rows from the
 * server dry-run response, recomputing target slugs on edit, gating the
 * confirm button, and assembling the apply payload. No React, no network —
 * fully unit-testable.
 */
import type { RenameRow } from "./rename-all-server-types";

export interface EditableRow extends RenameRow {
  included: boolean;
  /** Local edit buffer for the proposed name. */
  draftName: string;
  /** Whether this row has been edited since the last server revalidation. */
  dirty: boolean;
}

export function toEditableRows(rows: RenameRow[]): EditableRow[] {
  return rows.map((r) => ({
    ...r,
    included: r.status === "renamable",
    draftName: r.suggested_name,
    dirty: false,
  }));
}

/** Merge a server revalidation result back into editable rows, preserving the
 *  user's include toggle. Rows whose asset_id isn't in the server response are
 *  left untouched. */
export function mergeRevalidated(
  current: EditableRow[],
  revalidated: RenameRow[],
): EditableRow[] {
  const byId = new Map(revalidated.map((r) => [r.asset_id, r]));
  return current.map((row) => {
    const fresh = byId.get(row.asset_id);
    if (!fresh) return row;
    return {
      ...fresh,
      included: fresh.status === "renamable" && row.included,
      draftName: fresh.suggested_name,
      dirty: false,
    };
  });
}

/** Apply a name edit to a single row, marking it dirty so the UI knows it
 *  needs revalidation before confirm. */
export function editRowName(
  rows: EditableRow[],
  assetId: string,
  name: string,
): EditableRow[] {
  return rows.map((row) =>
    row.asset_id === assetId
      ? { ...row, draftName: name, dirty: row.draftName !== name ? true : row.dirty }
      : row,
  );
}

export function toggleRowIncluded(
  rows: EditableRow[],
  assetId: string,
): EditableRow[] {
  return rows.map((row) =>
    row.asset_id === assetId ? { ...row, included: !row.included } : row,
  );
}

/** Whether any included row still needs a server revalidation pass. */
export function hasDirtyRows(rows: EditableRow[]): boolean {
  return rows.some((r) => r.included && r.dirty);
}

/** Whether the confirm button should be enabled: at least one renamable
 *  included row, no dirty (unedited) rows, and no conflicts among included. */
export function canConfirm(rows: EditableRow[]): boolean {
  if (hasDirtyRows(rows)) return false;
  const included = rows.filter((r) => r.included);
  if (included.length === 0) return false;
  return included.every((r) => r.status === "renamable" || r.status === "unchanged");
}

/** Build the renames payload sent to the server for dry-run revalidation. */
export function buildRevalidatePayload(
  rows: EditableRow[],
): Array<{ asset_id: string; suggested_name: string }> {
  return rows
    .filter((r) => r.status !== "skipped")
    .map((r) => ({ asset_id: r.asset_id, suggested_name: r.draftName.trim() }));
}

/** Build the renames payload sent to the server for the final apply. Only
 *  included, renamable rows are sent. */
export function buildApplyPayload(
  rows: EditableRow[],
): Array<{ asset_id: string; suggested_name: string }> {
  return rows
    .filter((r) => r.included && r.status === "renamable")
    .map((r) => ({ asset_id: r.asset_id, suggested_name: r.suggested_name }));
}

/** Compute the target slug client-side for live preview while editing. This
 *  mirrors the server's computeTargetSlug loosely (no stop-word filter on the
 *  client) — the authoritative target comes from the server revalidation. */
export function previewTargetSlug(
  proposedName: string,
  currentId: string,
  occupiedIds: Set<string>,
): string {
  const idx = currentId.indexOf("-");
  const prefix = idx === -1 ? currentId : currentId.slice(0, idx);
  const slug = proposedName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/[\s-]+/)
    .filter((w) => w.length > 0)
    .slice(0, 4)
    .join("-");
  const base = slug ? `${prefix}-${slug}` : `${prefix}-untitled`;
  if (base === currentId) return base;
  let candidate = base;
  let counter = 2;
  while (occupiedIds.has(candidate) && candidate !== currentId) {
    candidate = `${base}-${counter}`;
    counter++;
  }
  return candidate;
}

/** Status badge label for a row. */
export function statusLabel(row: EditableRow): string {
  switch (row.status) {
    case "renamable":
      return row.included ? "will rename" : "excluded";
    case "skipped":
      return "skipped";
    case "unchanged":
      return "no change";
    case "conflict":
      return "conflict";
  }
}
