/**
 * Pure helpers for the rename_all tool: deterministic slug computation that
 * mirrors videocity-engine's slugifyName, humanization for display, dry-run
 * row building, edited-name revalidation, and reference rewriting.
 *
 * These are kept side-effect-free and engine-agnostic so the dry-run target
 * prediction is testable without a filesystem or network. The engine's
 * `fs.renameAsset` re-runs collision resolution at apply time and may add a
 * `-N` suffix if a historical slug collision appears; callers should treat the
 * predicted `target_asset_id` as authoritative for in-flight assets and rely
 * on the apply result's `new_asset_id` for the final id.
 */

/** Asset prefixes eligible for rename-all (matches the preview scope). */
export const RENAME_PREFIXES = ["vid", "img"] as const;
export type RenamePrefix = (typeof RENAME_PREFIXES)[number];

/** Engine stop-word list — kept in sync with videocity-engine/asset/slug.js.
 *  Reproduced locally because the engine does not export slugifyName. */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "as", "is", "was", "are", "were", "been", "be",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "this", "that",
  "these", "those", "it", "its", "my", "your", "his", "her", "our", "their",
  "what", "which", "who", "whom", "whose", "where", "when", "why", "how",
  "all", "each", "every", "both", "few", "more", "most", "other", "some",
  "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too",
  "very", "just", "also",
]);

/** Maximum content words in a slug (engine truncates to 4). */
const MAX_SLUG_WORDS = 4;

export type RenameStatus = "renamable" | "skipped" | "unchanged" | "conflict";

export interface RenameRow {
  asset_id: string;
  type: "video" | "image";
  current_slug: string;
  current_name: string;
  suggested_name: string;
  target_asset_id: string;
  status: RenameStatus;
  reason?: string;
}

export interface AssetContext {
  asset_id: string;
  type: string;
  context_text: string;
}

export interface EditedRename {
  asset_id: string;
  suggested_name: string;
}

/** Replicate videocity-engine slugifyName(name, prefix). */
export function slugifyName(name: string, prefix: string): string {
  const prefixLower = prefix.toLowerCase().replace(/-$/, "");
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/[\s-]+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
    .filter((w) => w !== prefixLower);

  const deduped: string[] = [];
  for (const w of words) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== w) {
      deduped.push(w);
    }
  }
  const slug = deduped.slice(0, MAX_SLUG_WORDS).join("-");
  return slug ? `${prefix}-${slug}` : `${prefix}-untitled`;
}

/** Strip the type prefix and title-case the remainder for display. */
export function humanizeSlug(slug: string): string {
  const rawName = slug.replace(/^[a-z]+-/, "");
  return rawName
    .split("-")
    .map((w) => (w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export function prefixOf(assetId: string): string {
  const idx = assetId.indexOf("-");
  return idx === -1 ? assetId : assetId.slice(0, idx);
}

/** Whether an asset id is in the rename-all preview scope. */
export function isRenamable(assetId: string): boolean {
  return RENAME_PREFIXES.some((p) => assetId.startsWith(`${p}-`));
}

/** Generic first tokens that are not user/project mnemonics worth preserving. */
const GENERIC_SLUG_TOKENS = new Set([
  "untitled", "new", "copy", "final", "temp", "test", "image", "video",
  "frame", "first", "last", "clip", "shot", "render", "export", "upload",
]);

/**
 * Leading short mnemonic after the type prefix (e.g. `nbp` in
 * `img-nbp-updat-ethe-device`, `mmm` in `img-mmm-device`). Letters only,
 * 2–4 chars, not a stop/generic word — so digit stubs like `a1` are ignored.
 */
export function leadingMnemonicTokens(assetId: string): string[] {
  const parts = assetId.toLowerCase().split("-").slice(1);
  if (parts.length === 0) return [];
  const part = parts[0];
  if (
    /^[a-z]{2,4}$/.test(part) &&
    !STOP_WORDS.has(part) &&
    !GENERIC_SLUG_TOKENS.has(part)
  ) {
    return [part];
  }
  return [];
}

/** Ensure AI-proposed names keep the short mnemonic from the current slug. */
export function withPreservedMnemonic(
  suggestedName: string,
  assetId: string,
): string {
  const keep = leadingMnemonicTokens(assetId);
  if (keep.length === 0) return suggestedName.trim();

  const words = suggestedName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 0);

  const present = new Set(words);
  const missing = keep.filter((t) => !present.has(t));
  if (missing.length === 0) return words.join(" ");

  // Prepend missing mnemonics; prefer short names overall.
  return [...missing, ...words].join(" ");
}

/** Predict the final target asset id for a proposed name, resolving only
 *  batch-internal collisions (two renames claiming the same slug) by suffixing.
 *  Collisions with pre-existing assets are NOT auto-suffixed here — callers
 *  surface those as conflicts so the user decides.
 *
 *  `claimedTargets` = target ids already spoken for by earlier rows in the
 *  same batch (mutated in place by the caller loop). */
export function computeTargetSlug(
  proposedName: string,
  currentId: string,
  claimedTargets: Set<string>,
): string {
  const prefix = prefixOf(currentId);
  const base = slugifyName(proposedName, prefix);

  // No-op rename → target equals current id.
  if (base === currentId) return base;

  let candidate = base;
  let counter = 2;
  while (claimedTargets.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter++;
  }
  return candidate;
}

/** Build the user-visible rows from the AI suggestion map, marking skipped /
 *  unchanged / conflict rows. `suggestions` maps asset_id → proposed name.
 *  Collisions within the batch are suffixed; collisions with pre-existing
 *  (non-batch) assets are surfaced as conflicts. */
export function buildRenameRows(
  assets: AssetContext[],
  suggestions: Record<string, string>,
  allAssetIds: string[],
): RenameRow[] {
  const batchIds = new Set(assets.map((a) => a.asset_id));
  const existingIds = new Set(allAssetIds.filter((id) => !batchIds.has(id)));
  const claimed = new Set<string>();
  const rows: RenameRow[] = [];

  for (const asset of assets) {
    const prefix = prefixOf(asset.asset_id);
    const currentName = humanizeSlug(asset.asset_id);
    const proposed = suggestions[asset.asset_id];

    if (!proposed || !proposed.trim()) {
      rows.push({
        asset_id: asset.asset_id,
        type: prefix === "vid" ? "video" : "image",
        current_slug: asset.asset_id,
        current_name: currentName,
        suggested_name: currentName,
        target_asset_id: asset.asset_id,
        status: "skipped",
        reason: "No suggestion produced",
      });
      continue;
    }

    const cleanedName = withPreservedMnemonic(proposed, asset.asset_id);
    const base = slugifyName(cleanedName, prefix);

    if (base === asset.asset_id) {
      rows.push({
        asset_id: asset.asset_id,
        type: prefix === "vid" ? "video" : "image",
        current_slug: asset.asset_id,
        current_name: currentName,
        suggested_name: cleanedName,
        target_asset_id: asset.asset_id,
        status: "unchanged",
        reason: "Slug unchanged after normalization",
      });
      continue;
    }

    const target = computeTargetSlug(cleanedName, asset.asset_id, claimed);

    if (existingIds.has(target)) {
      rows.push({
        asset_id: asset.asset_id,
        type: prefix === "vid" ? "video" : "image",
        current_slug: asset.asset_id,
        current_name: currentName,
        suggested_name: cleanedName,
        target_asset_id: target,
        status: "conflict",
        reason: `Target ${target} already in use`,
      });
      continue;
    }

    claimed.add(target);
    rows.push({
      asset_id: asset.asset_id,
      type: prefix === "vid" ? "video" : "image",
      current_slug: asset.asset_id,
      current_name: currentName,
      suggested_name: cleanedName,
      target_asset_id: target,
      status: "renamable",
    });
  }

  return rows;
}

/** Revalidate a user-edited set of renames against the live asset list and
 *  return fresh rows with exact target ids. Collisions within the batch are
 *  suffixed; collisions with pre-existing assets are conflicts. This is the
 *  dry-run-with-edits path: names may have changed, so targets are recomputed. */
export function validateEditedRenames(
  edits: EditedRename[],
  allAssetIds: string[],
): RenameRow[] {
  const batchIds = new Set(edits.map((e) => e.asset_id));
  const existingIds = new Set(allAssetIds.filter((id) => !batchIds.has(id)));
  const claimed = new Set<string>();
  const rows: RenameRow[] = [];

  for (const edit of edits) {
    const exists = allAssetIds.includes(edit.asset_id);
    const prefix = prefixOf(edit.asset_id);
    const currentName = humanizeSlug(edit.asset_id);
    const trimmed = edit.suggested_name.trim();

    if (!exists) {
      rows.push({
        asset_id: edit.asset_id,
        type: prefix === "vid" ? "video" : "image",
        current_slug: edit.asset_id,
        current_name: currentName,
        suggested_name: edit.suggested_name,
        target_asset_id: edit.asset_id,
        status: "conflict",
        reason: "Asset no longer exists",
      });
      continue;
    }

    if (!trimmed) {
      rows.push({
        asset_id: edit.asset_id,
        type: prefix === "vid" ? "video" : "image",
        current_slug: edit.asset_id,
        current_name: currentName,
        suggested_name: edit.suggested_name,
        target_asset_id: edit.asset_id,
        status: "conflict",
        reason: "Empty name",
      });
      continue;
    }

    const base = slugifyName(trimmed, prefix);
    if (base === edit.asset_id) {
      rows.push({
        asset_id: edit.asset_id,
        type: prefix === "vid" ? "video" : "image",
        current_slug: edit.asset_id,
        current_name: currentName,
        suggested_name: trimmed,
        target_asset_id: edit.asset_id,
        status: "unchanged",
        reason: "Slug unchanged after normalization",
      });
      continue;
    }

    const target = computeTargetSlug(trimmed, edit.asset_id, claimed);

    if (existingIds.has(target)) {
      rows.push({
        asset_id: edit.asset_id,
        type: prefix === "vid" ? "video" : "image",
        current_slug: edit.asset_id,
        current_name: currentName,
        suggested_name: trimmed,
        target_asset_id: target,
        status: "conflict",
        reason: `Target ${target} already in use`,
      });
      continue;
    }

    claimed.add(target);
    rows.push({
      asset_id: edit.asset_id,
      type: prefix === "vid" ? "video" : "image",
      current_slug: edit.asset_id,
      current_name: currentName,
      suggested_name: trimmed,
      target_asset_id: target,
      status: "renamable",
    });
  }

  return rows;
}

/** Rows that will actually be renamed at apply time. */
export function applyableRows(rows: RenameRow[]): RenameRow[] {
  return rows.filter((r) => r.status === "renamable");
}

// --- GPT prompt construction (pure) -----------------------------------------

/** Origins that describe how an image was produced, not what it shows. */
export const PROCESS_ORIGINS = new Set([
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
 *  asset_id → short descriptive name. Kept pure for unit testing.
 *  When `hasImages` is true, the message notes that preview frames follow. */
export function buildSuggestionPrompt(
  assets: AssetContext[],
  opts: { hasImages?: boolean } = {},
): string {
  const entries = assets.map((a) => {
    const mnemonic = leadingMnemonicTokens(a.asset_id);
    const keep = mnemonic.length > 0 ? `; keep token: ${mnemonic.join(" ")}` : "";
    const label = `${a.asset_id} (${a.type}${keep})`;
    const snippet = a.context_text.slice(0, 700).replace(/\s+/g, " ").trim();
    return snippet
      ? `- ${label}: ${snippet}`
      : `- ${label}: (no text context — use the preview image)`;
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
    "You rename video and image assets in a creative project so their slugs",
    "describe their VISUAL content. For each asset, propose a VERY SHORT name:",
    "prefer 1–2 content words (3 max). Think folder tags, not sentences.",
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
    "- If the entry says \"keep token: X\" (e.g. nbp, mmm), the name MUST start",
    "  with that token, then 1–2 short content words: \"nbp device\", \"mmm gadget\".",
    "- Make names distinct within this batch when assets look different.",
    "- Keep names lowercase plain words (no punctuation, no full asset ids).",
    "",
    ...imageNote,
    "Return ONLY a JSON object mapping each asset_id to the proposed name.",
    "Example: {\"vid-abc123\": \"gadget pitch\", \"img-nbp-old\": \"nbp device\"}",
    "",
    "Assets:",
    ...entries,
  ].join("\n");
}

/** Parse the GPT JSON response into an asset_id → name map, tolerating a
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

// --- Reference rewriting (pure, works on parsed structures) -----------------

type TimelineSlot = { slug?: string };
type TimelineAudioClip = { slug?: string };
interface TimelineConfig {
  slots?: TimelineSlot[];
  audio?: TimelineAudioClip[];
  [k: string]: unknown;
}

/** Rewrite asset id references inside a parsed timeline config. Mutates and
 *  returns the same object. Pure with respect to the outside world. */
export function rewriteTimelineReferences(
  config: TimelineConfig,
  idMap: Map<string, string>,
): TimelineConfig {
  if (Array.isArray(config.slots)) {
    for (const slot of config.slots) {
      if (slot.slug && idMap.has(slot.slug)) {
        slot.slug = idMap.get(slot.slug);
      }
    }
  }
  if (Array.isArray(config.audio)) {
    for (const clip of config.audio) {
      if (clip.slug && idMap.has(clip.slug)) {
        clip.slug = idMap.get(clip.slug);
      }
    }
  }
  return config;
}

/** Recursively rewrite any string value equal to a key in idMap. Returns the
 *  same object reference with replacements applied in place. Used for the
 *  deeply nested plan/.plan.json sidecar. */
export function rewriteDeep<T>(value: T, idMap: Map<string, string>): T {
  if (typeof value === "string") {
    return (idMap.get(value) ?? value) as T;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = rewriteDeep(value[i], idMap);
    }
    return value;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const v = (value as Record<string, unknown>)[key];
      (value as Record<string, unknown>)[key] = rewriteDeep(v, idMap);
    }
  }
  return value;
}
