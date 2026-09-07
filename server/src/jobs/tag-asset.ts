/**
 * The queued tagging coordinator.
 *
 * One job type tags every kind of asset, because the hard parts — deciding
 * which content was analyzed, refusing to publish a stale result, and leaving
 * a user's own tags alone — are the same everywhere. What differs is only
 * where the evidence lives, and that is a lookup.
 *
 * Three properties this job must hold:
 *
 * - **Detached from readiness.** Tagging never touches the artifact work row.
 *   A book whose provider key is missing still plays its media; only its tags
 *   are absent, and the outcome says so.
 * - **Fenced to the content.** The fence is the primary media file's hash, not
 *   the asset's whole-directory fingerprint, which changes whenever a sidecar
 *   is written — including the analysis and tag writes this job itself causes.
 *   Fencing on the directory would make every run trigger the next one.
 * - **Idempotent.** The job id carries book, artifact, source hash and
 *   analyzer version, so a restart, a duplicate completion event and a second
 *   enqueue collapse into one run; a forced retry opts out explicitly.
 */

import type { ArtifactKind, Engine } from "videobook-engine";
import { findAudioFile, findPrimaryMediaFile } from "videobook-engine";
import { getApiKey } from "../api-key.js";
import { logger } from "../logger.js";
import { queue, registerJobHandler } from "../queue.js";
import {
  tagsFromImageAnalysis,
  tagsFromScriptText,
  tagsFromTranscript,
  tagsFromVideoAnalysis,
  type TagExtraction,
  type TranscriptEvidence,
} from "../asset-tag-extraction.js";
import { readTaggingSettings } from "../tag-settings.js";
import { TAG_ANALYZER_VERSION } from "../tag-vocabulary.js";

const ANALYSIS_FILENAME = ".original.analysis.json";

/**
 * Kinds that carry something automatic tagging can read. A character sheet or
 * a prompt is not untagged because analysis failed — there is nothing about it
 * to analyze, and manual tags remain available on every kind.
 */
const TAGGABLE_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  "image",
  "video",
  "final",
  "audio",
  "script",
]);

export type TagAssetPayload = {
  type: "tag_asset";
  bookId: string;
  assetId: string;
  /** Re-tag even when the fence says this content is already covered. */
  force?: boolean;
  /**
   * Adopt cached analysis only. A backfill pass uses this to sweep an entire
   * library for free and report what would still need inference, instead of
   * spending on every untagged asset the moment someone asks for counts.
   */
  cacheOnly?: boolean;
};

export type TagAssetResult = {
  assetId: string;
  outcome:
    | "tagged"
    | "no_useful_evidence"
    | "no_evidence"
    | "unsupported_kind"
    | "already_current"
    | "missing_asset"
    | "no_source_content"
    /** Analysis was queued; tagging resumes when the evidence lands. */
    | "analysis_requested"
    /** Nothing is configured that could analyze this content. */
    | "analysis_unavailable";
  tagCount: number;
  sourceHash: string | null;
  analyzerVersion: string;
};

/**
 * The bytes a tag describes. Rendered orientations and sidecars are excluded:
 * a tag is a claim about the content someone sees, and re-rendering does not
 * change that content.
 */
async function primarySourceHash(
  engine: Engine,
  assetId: string,
  kind: ArtifactKind,
): Promise<string | null> {
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) return null;
  const files = manifest.value.files;
  if (kind === "script") {
    const document = files.find((file) => !file.name.startsWith("."));
    return document?.objectHash ?? null;
  }
  const primary = kind === "audio"
    ? findAudioFile(files, kind) ?? findPrimaryMediaFile(files, kind)
    : findPrimaryMediaFile(files, kind);
  return primary?.objectHash ?? null;
}

async function readAnalysis(
  engine: Engine,
  assetId: string,
): Promise<unknown | null> {
  const read = await engine.files.read(assetId, ANALYSIS_FILENAME);
  if (!read.ok) return null;
  try {
    return JSON.parse(read.value.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

async function transcriptEvidence(
  engine: Engine,
  assetId: string,
): Promise<TranscriptEvidence | null> {
  const transcripts = await engine.transcripts.list(assetId);
  const latest = transcripts.ok ? transcripts.value.at(-1) : undefined;
  if (!latest) return null;
  const segments = latest.segments ?? [];
  const wordCount = segments.reduce(
    (total, segment) => total + segment.text.trim().split(/\s+/u).filter(Boolean).length,
    0,
  );
  const speakers = new Set(
    segments.flatMap((segment) => (segment.speaker ? [segment.speaker] : [])),
  );
  return { wordCount, speakerCount: speakers.size };
}

async function readScriptText(
  engine: Engine,
  assetId: string,
): Promise<string | null> {
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) return null;
  const document = manifest.value.files.find((file) =>
    /\.(md|txt|fountain)$/iu.test(file.name));
  if (!document) return null;
  const read = await engine.files.read(assetId, document.name);
  return read.ok ? read.value.toString("utf8") : null;
}

/**
 * Which evidence a kind carries. Audio has no frames, images have no
 * transcript, and a kind with neither is not a failure — it simply has
 * nothing automatic tagging can read.
 */
async function extractForKind(
  engine: Engine,
  assetId: string,
  kind: ArtifactKind,
): Promise<TagExtraction> {
  if (kind === "image") {
    return tagsFromImageAnalysis(await readAnalysis(engine, assetId));
  }
  if (kind === "video" || kind === "final") {
    const fromFrames = tagsFromVideoAnalysis(await readAnalysis(engine, assetId));
    if (fromFrames.outcome === "tagged") return fromFrames;
    // A video whose analysis said nothing useful can still be grouped by what
    // its transcript supports.
    const fromSpeech = tagsFromTranscript(await transcriptEvidence(engine, assetId));
    return fromSpeech.outcome === "tagged" ? fromSpeech : fromFrames;
  }
  if (kind === "audio") {
    return tagsFromTranscript(await transcriptEvidence(engine, assetId));
  }
  if (kind === "script") {
    return tagsFromScriptText(await readScriptText(engine, assetId));
  }
  return { tags: [], outcome: "unsupported_kind" };
}

/** Deterministic id: the same content and analyzer never queue twice. */
export function tagAssetJobId(
  bookId: string,
  assetId: string,
  sourceHash: string,
): string {
  return `tag-asset-${bookId}-${assetId}-${sourceHash}-${TAG_ANALYZER_VERSION}`;
}

/**
 * Queues tagging for one asset. Callers are completion tails — upload,
 * processing, generation, analysis — so this must never throw into them: an
 * asset that cannot be tagged is still a usable asset.
 */
export async function enqueueAssetTagging(
  engine: Engine,
  assetId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  try {
    if (!options.force && !readTaggingSettings(engine).automaticEnabled) return;
    const bookId = engine.book.get().bookId;
    const artifact = engine.artifacts.get(assetId);
    if (!artifact.ok) return;
    const sourceHash = await primarySourceHash(
      engine,
      assetId,
      artifact.value.kind,
    );
    if (!sourceHash) return;
    await queue.enqueue(tagAssetJobId(bookId, assetId, sourceHash), {
      type: "tag_asset",
      bookId,
      assetId,
      ...(options.force ? { force: true } : {}),
    } as unknown as Record<string, unknown>);
  } catch (cause) {
    logger.warn("tag-asset-failed", { assetId, error: cause });
  }
}

export async function runAssetTagging(
  engine: Engine,
  payload: TagAssetPayload,
): Promise<TagAssetResult> {
  const { assetId, force } = payload;
  const base = { assetId, tagCount: 0, analyzerVersion: TAG_ANALYZER_VERSION };
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) {
    return { ...base, outcome: "missing_asset", sourceHash: null };
  }
  if (!TAGGABLE_KINDS.has(artifact.value.kind)) {
    return { ...base, outcome: "unsupported_kind", sourceHash: null };
  }
  const sourceHash = await primarySourceHash(engine, assetId, artifact.value.kind);
  if (!sourceHash) {
    return { ...base, outcome: "no_source_content", sourceHash: null };
  }

  // The engine keeps the last accepted snapshot. Re-running over the same
  // content with the same analyzer would spend a write to reach the same
  // state, and would clear nothing a user has since dismissed.
  const snapshot = engine.tags.automatic.snapshot(assetId);
  const current = snapshot.ok ? snapshot.value : undefined;
  if (
    !force
    && current
    && current.sourceHash === sourceHash
    && current.extractorVersion === TAG_ANALYZER_VERSION
    && !current.stale
  ) {
    return { ...base, outcome: "already_current", sourceHash };
  }

  const extraction = await extractForKind(engine, assetId, artifact.value.kind);
  if (extraction.outcome === "unsupported_kind") {
    return { ...base, outcome: extraction.outcome, sourceHash };
  }
  if (extraction.outcome === "no_evidence") {
    if (payload.cacheOnly) {
      // Nothing usable is cached. Saying so is the point of a cache-only pass:
      // the asset is counted as needing analysis rather than claimed current.
      return { ...base, outcome: "no_evidence", sourceHash };
    }
    // Analysis is otherwise gated on dropping an asset into a timeline, which
    // would leave everything that stays in the Library untagged. Ask for it
    // here instead; the analysis tail re-queues this job, and the dedupe key
    // is free again by then because this run has finished.
    const requested = await requestAnalysis(engine, payload.bookId, assetId, artifact.value.kind);
    return { ...base, outcome: requested, sourceHash };
  }

  // Re-read the hash: the content may have been replaced while the evidence
  // was being read, and publishing against the old bytes would describe media
  // the asset no longer has.
  const publishHash = await primarySourceHash(engine, assetId, artifact.value.kind);
  if (publishHash !== sourceHash) {
    return { ...base, outcome: "no_source_content", sourceHash: publishHash };
  }

  const replaced = await engine.tags.automatic.replace({
    artifactId: assetId,
    sourceHash,
    generator: "videobook-editorial-tagger",
    extractorVersion: TAG_ANALYZER_VERSION,
    tags: extraction.tags,
  });
  if (!replaced.ok) {
    logger.warn("tag-asset-failed", { assetId, error: replaced.error });
    return { ...base, outcome: extraction.outcome, sourceHash };
  }
  return {
    ...base,
    outcome: extraction.outcome,
    tagCount: extraction.tags.length,
    sourceHash,
  };
}

/**
 * Asks for the evidence this kind needs. Nothing here waits: the analysis job
 * caches its result and re-queues tagging, so a missing provider key costs an
 * outcome rather than a failed job on a perfectly good asset.
 */
async function requestAnalysis(
  engine: Engine,
  bookId: string,
  assetId: string,
  kind: ArtifactKind,
): Promise<"analysis_requested" | "analysis_unavailable" | "no_evidence"> {
  if (kind !== "image" && kind !== "video" && kind !== "final") return "no_evidence";
  if (!readTaggingSettings(engine).analysisOnNewAssets) return "no_evidence";
  if (!getApiKey("OPENAI_API_KEY")) return "analysis_unavailable";
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) return "no_evidence";
  if (kind === "image") {
    const original = manifest.value.files.find((file) =>
      /^original\.(jpe?g|png|webp)$/iu.test(file.name));
    if (!original) return "no_evidence";
    await queue.enqueue(`auto-describe-${assetId}`, {
      type: "describe_image",
      bookId,
      sourceAssetId: assetId,
      sourceImageFilename: original.name,
    } as unknown as Record<string, unknown>);
    return "analysis_requested";
  }
  if (kind === "video" || kind === "final") {
    await queue.enqueue(`auto-analyze-${assetId}`, {
      type: "analyze_video",
      bookId,
      assetId,
      assetDir: manifest.value.path,
      hasTranscription: false,
      // Tagging wants the analysis and nothing else: an asset nobody has put
      // on a timeline must not pull transcription and rendering along behind
      // it just because it was tagged.
      purpose: "tagging",
    } as unknown as Record<string, unknown>);
    return "analysis_requested";
  }
  return "no_evidence";
}

export function registerTagAssetJob(engine: Engine): void {
  registerJobHandler("tag_asset", async (payload) =>
    await runAssetTagging(engine, payload as TagAssetPayload));
}
