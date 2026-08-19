/** Asset kinds eligible for rename-all (matches the preview scope). */
export const RENAME_KINDS = ["video", "image"] as const;
type RenameKind = (typeof RENAME_KINDS)[number];

type RenameStatus = "renamable" | "skipped" | "unchanged" | "conflict";

export interface RenameRow {
  asset_id: string;
  type: RenameKind;
  current_name: string;
  suggested_name: string;
  status: RenameStatus;
  reason?: string;
}

export interface AssetContext {
  asset_id: string;
  type: string;
  /** Current display label, when the artifact has one. */
  label?: string;
  context_text: string;
}

export interface EditedRename {
  asset_id: string;
  suggested_name: string;
}

/** A live artifact the rename batch is validated against. */
export interface RenameCandidate {
  artifactId: string;
  label?: string;
  kind: string;
}

export function isRenamableKind(kind: string): kind is RenameKind {
  return RENAME_KINDS.some((candidate) => candidate === kind);
}

function rowKind(kind: string): RenameKind {
  return kind === "video" ? "video" : "image";
}

function displayName(label: string | undefined, artifactId: string): string {
  return label ?? artifactId;
}

/** Build the user-visible rows from the AI suggestion map, marking skipped and
 *  unchanged rows. `suggestions` maps asset_id → proposed label. Labels are
 *  free text with no uniqueness constraint, so there are no collisions to
 *  resolve. */
export function buildRenameRows(
  assets: AssetContext[],
  suggestions: Record<string, string>,
): RenameRow[] {
  const rows: RenameRow[] = [];

  for (const asset of assets) {
    const currentName = displayName(asset.label, asset.asset_id);
    const proposed = suggestions[asset.asset_id]?.trim();

    if (!proposed) {
      rows.push({
        asset_id: asset.asset_id,
        type: rowKind(asset.type),
        current_name: currentName,
        suggested_name: currentName,
        status: "skipped",
        reason: "No suggestion produced",
      });
      continue;
    }

    if (proposed === asset.label) {
      rows.push({
        asset_id: asset.asset_id,
        type: rowKind(asset.type),
        current_name: currentName,
        suggested_name: proposed,
        status: "unchanged",
        reason: "Label already matches",
      });
      continue;
    }

    rows.push({
      asset_id: asset.asset_id,
      type: rowKind(asset.type),
      current_name: currentName,
      suggested_name: proposed,
      status: "renamable",
    });
  }

  return rows;
}

/** Revalidate a user-edited set of renames against the live asset list. This
 *  is the dry-run-with-edits path: assets may have been deleted or relabeled
 *  since the suggestion pass, so every row is rechecked. */
export function validateEditedRenames(
  edits: EditedRename[],
  candidates: RenameCandidate[],
): RenameRow[] {
  const byId = new Map(candidates.map((candidate) => [candidate.artifactId, candidate]));
  const rows: RenameRow[] = [];

  for (const edit of edits) {
    const candidate = byId.get(edit.asset_id);
    const trimmed = edit.suggested_name.trim();

    if (!candidate) {
      rows.push({
        asset_id: edit.asset_id,
        type: "image",
        current_name: edit.asset_id,
        suggested_name: edit.suggested_name,
        status: "conflict",
        reason: "Asset no longer exists",
      });
      continue;
    }

    const currentName = displayName(candidate.label, candidate.artifactId);

    if (!isRenamableKind(candidate.kind)) {
      rows.push({
        asset_id: edit.asset_id,
        type: rowKind(candidate.kind),
        current_name: currentName,
        suggested_name: edit.suggested_name,
        status: "conflict",
        reason: `Only video and image assets are renamable here (got ${candidate.kind})`,
      });
      continue;
    }

    if (!trimmed) {
      rows.push({
        asset_id: edit.asset_id,
        type: rowKind(candidate.kind),
        current_name: currentName,
        suggested_name: edit.suggested_name,
        status: "conflict",
        reason: "Empty name",
      });
      continue;
    }

    if (trimmed === candidate.label) {
      rows.push({
        asset_id: edit.asset_id,
        type: rowKind(candidate.kind),
        current_name: currentName,
        suggested_name: trimmed,
        status: "unchanged",
        reason: "Label already matches",
      });
      continue;
    }

    rows.push({
      asset_id: edit.asset_id,
      type: rowKind(candidate.kind),
      current_name: currentName,
      suggested_name: trimmed,
      status: "renamable",
    });
  }

  return rows;
}

/** Rows that will actually be relabeled at apply time. */
export function applyableRows(rows: RenameRow[]): RenameRow[] {
  return rows.filter((r) => r.status === "renamable");
}

// --- GPT prompt construction (pure) -----------------------------------------

/** Origins that describe how an image was produced, not what it shows. */
const PROCESS_ORIGINS = new Set([
  "first_frame",
  "last_frame",
  "custom_frame",
  "external",
  "upload",
  "apply_cuts",
]);

/** Whether a metadata origin is a process label (useless alone for naming). */
export function isProcessOrigin(origin: string): boolean {
  return PROCESS_ORIGINS.has(origin.trim().toLowerCase());
}

/** Build the single GPT-5.5 user message requesting a JSON map of
 *  asset_id → short descriptive label. Kept pure for unit testing.
 *  When `hasImages` is true, the message notes that preview frames follow. */
export function buildSuggestionPrompt(
  assets: AssetContext[],
  opts: { hasImages?: boolean } = {},
): string {
  const entries = assets.map((a) => {
    const current = a.label ? `; current label: ${a.label}` : "";
    const heading = `${a.asset_id} (${a.type}${current})`;
    const snippet = a.context_text.slice(0, 700).replace(/\s+/g, " ").trim();
    return snippet
      ? `- ${heading}: ${snippet}`
      : `- ${heading}: (no text context — use the preview image)`;
  });

  const imageNote = opts.hasImages
    ? [
        "Preview images follow this list: for each asset_id, one or more stills",
        "(videos: first frame then last frame; images: the image itself).",
        "Prefer what you SEE in the previews over process labels in the text.",
        "",
      ]
    : [];

  return [
    "You label video and image assets in a creative project so their display",
    "labels describe their VISUAL content. For each asset, propose a VERY SHORT",
    "label: prefer 1–2 content words (3 max). Think folder tags, not sentences.",
    "",
    "Rules:",
    "- Name the main subject or prop only (e.g. \"gadget pitch\", \"green device\").",
    "- Prefer concrete nouns over adjectives, settings, or abstract process words.",
    "- Do NOT invent details absent from the context text and preview images.",
    "- Do NOT name after pipeline/meta labels: last frame, first frame, update,",
    "  device image, locked off, fixed camera, external, upload, edit, regenerate.",
    "- Do NOT copy typo-ridden edit prompts (\"updat ethe device...\") — describe",
    "  the resulting image instead.",
    "- Prefer analysis/summary/visual cues over raw transcript; use spoken words",
    "  only when they name a distinctive prop or topic (e.g. a product brand).",
    "- Make labels distinct within this batch when assets look different.",
    "- Keep labels lowercase plain words (no punctuation, no artifact ids).",
    "",
    ...imageNote,
    "Return ONLY a JSON object mapping each asset_id to the proposed label.",
    "Example: {\"0198f9a2-…\": \"gadget pitch\", \"0198f9a3-…\": \"green device\"}",
    "",
    "Assets:",
    ...entries,
  ].join("\n");
}

/** Parse the GPT JSON response into an asset_id → label map, tolerating a
 *  leading code-fence or surrounding prose. Returns empty map on failure. */
export function parseSuggestionResponse(text: string): Record<string, string> {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  const objStart = candidate.indexOf("{");
  const objEnd = candidate.lastIndexOf("}");
  if (objStart === -1 || objEnd === -1 || objEnd <= objStart) return {};

  try {
    const parsed = JSON.parse(candidate.slice(objStart, objEnd + 1)) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
