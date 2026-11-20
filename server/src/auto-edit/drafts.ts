import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ArtifactManifestFile, Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import {
  analysisComponentState,
  enqueueAnalysisComponent,
  latestComponentJob,
} from "../analysis-components.js";
import { getApiKey } from "../api-key.js";
import { displayDimensions, type Rational } from "../captions/geometry.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { findCanonicalMediaFile } from "../original-media-file.js";
import { queue } from "../queue.js";
import {
  indexRenderRequest,
  indexedRenderRequests,
  renderDestination,
  renderRequestFingerprint,
  renderRequestRunning,
  renderRequestStatus,
  writeRenderSetting,
  type RenderRequestStatus,
} from "../render-requests.js";
import {
  AUTO_EDIT_MOMENTS,
  autoEditAnalysisView,
  autoEditMomentAnalysisSchema,
  autoEditMomentsKey,
  autoEditTranscriptHashes,
  readAutoEditAnalysisState,
  type AutoEditAnalysisView,
} from "./analysis.js";
import {
  checkSegmentPlan,
  secondsToFrame,
  segmentPlanSchema,
  type SegmentPlan,
  type SegmentSource,
} from "./plan.js";
import {
  autoEditAnchorsSchema,
  autoEditCuesSchema,
  autoEditSectionsSchema,
  buildAutoEditPlan,
  DEFAULT_AUTO_EDIT_SECTIONS,
  defaultAnchors,
  type AutoEditAnchors,
  type AutoEditCue,
  type AutoEditSections,
} from "./style.js";

export type AutoEditServiceErrorCode = "not_ready" | "invalid";

export class AutoEditServiceError extends Error {
  readonly code: AutoEditServiceErrorCode;

  constructor(code: AutoEditServiceErrorCode, message: string) {
    super(message);
    this.name = "AutoEditServiceError";
    this.code = code;
  }
}

export const AUTO_EDIT_RENDER_JOB = "render_auto_edit";
export const AUTO_EDIT_SOURCE_OPERATION = "auto_edit";

const FULL_NOTEBOOK_MESSAGE = "The notebook needs one empty cell for the auto-edit copy.";
const BUSY_STATES: ReadonlySet<string> = new Set([
  "uploading", "loading", "generating", "processing", "trimming", "cropping", "splicing",
  "reversing", "changing-speed", "replacing-audio", "rendering", "downloading", "deleting",
]);

export interface AutoEditSourceMedia {
  artifactId: string;
  kind: "video" | "final";
  label: string | null;
  file: ArtifactManifestFile;
  path: string;
  sourceHash: string;
  durationSeconds: number;
  fps: number;
  frames: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface StoredAutoEditDraft {
  revision: string;
  sourceHash: string;
  anchors: AutoEditAnchors;
  sections: AutoEditSections;
  changes?: string[];
}

export interface AutoEditRenderRequest {
  requestId: string;
  fingerprint: string;
  sourceArtifactId: string;
  outputArtifactId: string;
  notebookId: string | null;
  sourceHash: string;
  mode: "anchors" | "plan";
  anchors: AutoEditAnchors | null;
  sections: AutoEditSections | null;
  plan: SegmentPlan;
  cues: AutoEditCue[];
  jobId: number | null;
  createdAt: string;
}

export interface AutoEditGetResponse {
  source: {
    artifact_id: string;
    label: string | null;
    source_hash: string;
    duration: number;
    fps: number;
    frames: number;
    width: number;
    height: number;
    has_audio: boolean;
  };
  draft: {
    revision: string | null;
    default: boolean;
    anchors: AutoEditAnchors;
    sections: AutoEditSections;
  };
  plan: SegmentPlan;
  cues: AutoEditCue[];
  changes: string[];
  analysis: AutoEditAnalysisView;
  last_render: RenderRequestStatus | null;
}

export type AutoEditAnalyzeResponse =
  | {
    status: "cached";
    draft: AutoEditGetResponse["draft"];
    plan: SegmentPlan;
    cues: AutoEditCue[];
    changes: string[];
    analysis: AutoEditAnalysisView;
  }
  | {
    status: "queued" | "running";
    job_id: number;
  };

function draftKey(artifactId: string): string {
  return `auto-edit.draft.${artifactId}`;
}

function requestKey(requestId: string): string {
  return `auto-edit.request.${requestId}`;
}

function requestIndexKey(artifactId: string): string {
  return `auto-edit.requests.${artifactId}`;
}

function latestRenderKey(artifactId: string): string {
  return `auto-edit.render.${artifactId}`;
}

function rationalValue(value: Rational | undefined): number | null {
  if (!value || !Number.isFinite(value.numerator) || !Number.isFinite(value.denominator) || value.denominator === 0) {
    return null;
  }
  const result = value.numerator / value.denominator;
  return result > 0 ? result : null;
}

function segmentSourceOf(source: AutoEditSourceMedia): SegmentSource {
  return {
    artifactId: source.artifactId,
    sourceHash: source.sourceHash,
    fps: source.fps,
    frames: source.frames,
    width: source.width,
    height: source.height,
    hasAudio: source.hasAudio,
  };
}

export async function readAutoEditSource(
  engine: Engine,
  artifactId: string,
  expectedHash?: string,
): Promise<AutoEditSourceMedia> {
  const artifact = engine.artifacts.get(artifactId);
  if (!artifact.ok) throw new Error(artifact.error.message);
  if (artifact.value.kind !== "video" && artifact.value.kind !== "final") {
    throw new Error("Choose a video cell for auto-edit.");
  }
  const status = await engine.status.get(artifactId);
  if (!status.ok) throw new Error(status.error.message);
  if (BUSY_STATES.has(status.value)) {
    throw new Error("The video is still processing. Wait for it to finish before auto-editing.");
  }
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = findCanonicalMediaFile(manifest.value.files, artifact.value.kind);
  if (!file) {
    throw new Error("The source video is missing. Wait for it to finish processing.");
  }
  if (expectedHash && file.objectHash !== expectedHash) {
    throw new Error("The source video changed since review. Reload auto-edit before rendering.");
  }
  const streams = engine.streams.list(artifactId);
  if (!streams.ok) throw new Error(streams.error.message);
  const matching = streams.value.filter(
    (stream) => stream.sourcePath === file.name && stream.objectHash === file.objectHash,
  );
  const video = matching.find((stream) => stream.kind === "video" && stream.video);
  if (!video?.video) {
    throw new Error("Wait for the video to finish processing before auto-editing.");
  }
  const durationSeconds = video.durationTicks * video.timeBase.numerator / video.timeBase.denominator;
  if (!(durationSeconds > 0)) {
    throw new Error("The source video has no measurable duration.");
  }
  const fps = rationalValue(video.video.nominalFrameRate)
    ?? rationalValue(video.video.averageFrameRate)
    ?? 30;
  const display = displayDimensions(video.video);
  const frames = Math.max(2, secondsToFrame(durationSeconds, fps));
  return {
    artifactId,
    kind: artifact.value.kind,
    label: artifact.value.label ?? null,
    file,
    path: join(manifest.value.path, file.name),
    sourceHash: file.objectHash,
    durationSeconds,
    fps,
    frames,
    width: display.width,
    height: display.height,
    hasAudio: matching.some((stream) => stream.kind === "audio"),
  };
}

export function readStoredAutoEditDraft(engine: Engine, artifactId: string): StoredAutoEditDraft | null {
  const raw = engine.settings.get<Record<string, unknown>>(draftKey(artifactId));
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.revision !== "string" || typeof raw.sourceHash !== "string") return null;
  const anchors = autoEditAnchorsSchema.safeParse(raw.anchors);
  const sections = autoEditSectionsSchema.safeParse(raw.sections);
  if (!anchors.success || !sections.success) return null;
  const changes = Array.isArray(raw.changes)
    ? raw.changes.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    revision: raw.revision,
    sourceHash: raw.sourceHash,
    anchors: anchors.data,
    sections: sections.data,
    ...(changes && changes.length > 0 ? { changes } : {}),
  };
}

export function saveAutoEditDraft(
  engine: Engine,
  artifactId: string,
  sourceHash: string,
  anchors: AutoEditAnchors,
  sections: AutoEditSections,
  changes?: readonly string[],
): StoredAutoEditDraft {
  const draft: StoredAutoEditDraft = {
    revision: randomUUID(),
    sourceHash,
    anchors,
    sections,
    ...(changes && changes.length > 0 ? { changes: [...changes] } : {}),
  };
  writeRenderSetting(engine, draftKey(artifactId), draft);
  return draft;
}

export function writeAutoEditAnalyzedDraft(
  engine: Engine,
  artifactId: string,
  sourceHash: string,
  anchors: AutoEditAnchors,
  changes: readonly string[] = [],
): StoredAutoEditDraft {
  const existing = readStoredAutoEditDraft(engine, artifactId);
  const sections = existing && existing.sourceHash === sourceHash
    ? existing.sections
    : { ...DEFAULT_AUTO_EDIT_SECTIONS };
  return saveAutoEditDraft(engine, artifactId, sourceHash, anchors, sections, changes);
}

export function deleteAutoEditDraft(engine: Engine, artifactId: string): void {
  engine.settings.delete(draftKey(artifactId));
}

export function readAutoEditRenderRequest(engine: Engine, requestId: string): AutoEditRenderRequest | null {
  const raw = engine.settings.get<Record<string, unknown>>(requestKey(requestId));
  if (!raw || typeof raw !== "object" || typeof raw.outputArtifactId !== "string") return null;
  const plan = segmentPlanSchema.safeParse(raw.plan);
  const cues = autoEditCuesSchema.safeParse(raw.cues ?? []);
  if (!plan.success || !cues.success) return null;
  const mode = raw.mode === "plan" ? "plan" : "anchors";
  const anchors = raw.anchors === null || raw.anchors === undefined
    ? null
    : autoEditAnchorsSchema.safeParse(raw.anchors);
  const sections = raw.sections === null || raw.sections === undefined
    ? null
    : autoEditSectionsSchema.safeParse(raw.sections);
  if ((anchors !== null && !anchors.success) || (sections !== null && !sections.success)) {
    return null;
  }
  return {
    requestId: typeof raw.requestId === "string" ? raw.requestId : requestId,
    fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : "",
    sourceArtifactId: typeof raw.sourceArtifactId === "string" ? raw.sourceArtifactId : "",
    outputArtifactId: raw.outputArtifactId,
    notebookId: typeof raw.notebookId === "string" ? raw.notebookId : null,
    sourceHash: typeof raw.sourceHash === "string" ? raw.sourceHash : "",
    mode,
    anchors: anchors ? anchors.data : null,
    sections: sections ? sections.data : null,
    plan: plan.data,
    cues: cues.data,
    jobId: typeof raw.jobId === "number" ? raw.jobId : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
  };
}

export function latestAutoEditRender(engine: Engine, artifactId: string): RenderRequestStatus | null {
  const requestId = engine.settings.get<string>(latestRenderKey(artifactId));
  if (typeof requestId !== "string") return null;
  const request = readAutoEditRenderRequest(engine, requestId);
  if (!request || !engine.artifacts.get(request.outputArtifactId).ok) return null;
  return renderRequestStatus(engine, request);
}

export function forgetAutoEditRenders(engine: Engine, artifactId: string): void {
  for (const requestId of indexedRenderRequests(engine, requestIndexKey(artifactId))) {
    const request = readAutoEditRenderRequest(engine, requestId);
    if (request) engine.settings.delete(latestRenderKey(request.sourceArtifactId));
    engine.settings.delete(requestKey(requestId));
  }
  engine.settings.delete(latestRenderKey(artifactId));
  engine.settings.delete(requestIndexKey(artifactId));
}

function isAutoEditOutputCell(cell: NotebookCell, sourceArtifactId: string): boolean {
  return cell.type === "video"
    && cell.inputs?.sourceOperation === AUTO_EDIT_SOURCE_OPERATION
    && cell.inputs?.sourceArtifactId === sourceArtifactId;
}

export function autoEditDestination(notebook: NotebookDocument, sourceArtifactId: string) {
  return renderDestination(
    notebook,
    sourceArtifactId,
    (cell) => isAutoEditOutputCell(cell, sourceArtifactId),
    FULL_NOTEBOOK_MESSAGE,
  );
}

function checkAutoEditNotebook(engine: Engine, notebookId: string | null, sourceArtifactId: string): void {
  if (!notebookId) return;
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  autoEditDestination(notebook.value, sourceArtifactId);
}

export async function readAutoEditGet(engine: Engine, artifactId: string): Promise<AutoEditGetResponse> {
  const source = await readAutoEditSource(engine, artifactId);
  const transcriptHashes = await autoEditTranscriptHashes(engine, artifactId);
  const analysisState = readAutoEditAnalysisState(engine, source.sourceHash, transcriptHashes);
  const segSource = segmentSourceOf(source);
  const saved = readStoredAutoEditDraft(engine, artifactId);
  const matches = saved !== null && saved.sourceHash === source.sourceHash;
  const anchors = matches ? saved.anchors : defaultAnchors(segSource);
  const sections = matches ? saved.sections : { ...DEFAULT_AUTO_EDIT_SECTIONS };
  const built = buildAutoEditPlan(segSource, anchors, sections);
  const changes = built.changes.length > 0 ? built.changes : (matches ? (saved.changes ?? []) : []);
  return {
    source: {
      artifact_id: source.artifactId,
      label: source.label,
      source_hash: source.sourceHash,
      duration: source.durationSeconds,
      fps: source.fps,
      frames: source.frames,
      width: source.width,
      height: source.height,
      has_audio: source.hasAudio,
    },
    draft: {
      revision: matches ? saved.revision : null,
      default: !matches,
      anchors: built.anchors,
      sections,
    },
    plan: built.plan,
    cues: built.cues,
    changes,
    analysis: autoEditAnalysisView(analysisState),
    last_render: latestAutoEditRender(engine, artifactId),
  };
}

export async function requestAutoEditAnalysis(
  engine: Engine,
  bookId: string,
  sourceArtifactId: string,
  force: boolean,
): Promise<AutoEditAnalyzeResponse> {
  const source = await readAutoEditSource(engine, sourceArtifactId);
  const transcriptHashes = await autoEditTranscriptHashes(engine, sourceArtifactId);
  const key = autoEditMomentsKey(source.sourceHash, transcriptHashes);
  const state = analysisComponentState(engine, AUTO_EDIT_MOMENTS, key, autoEditMomentAnalysisSchema);
  if ((state.status === "queued" || state.status === "running") && state.jobId !== null) {
    return { status: state.status, job_id: state.jobId };
  }
  if (!force && state.status === "ready" && state.value) {
    const saved = readStoredAutoEditDraft(engine, sourceArtifactId);
    if (!saved || saved.sourceHash !== source.sourceHash) {
      writeAutoEditAnalyzedDraft(engine, sourceArtifactId, source.sourceHash, state.value.anchors, state.value.changes);
    }
    const got = await readAutoEditGet(engine, sourceArtifactId);
    return {
      status: "cached",
      draft: got.draft,
      plan: got.plan,
      cues: got.cues,
      changes: got.changes.length > 0 ? got.changes : state.value.changes,
      analysis: got.analysis,
    };
  }
  if (!getApiKey("OPENAI_API_KEY")) {
    throw new AutoEditServiceError(
      "not_ready",
      "Find the moment needs an OpenAI API key (OPENAI_API_KEY), and the anchors can still be set by hand.",
    );
  }
  const enqueued = await enqueueAnalysisComponent(
    engine,
    AUTO_EDIT_MOMENTS,
    key,
    { bookId, sourceArtifactId },
    { force, hasResult: state.status === "ready" },
  );
  const job = latestComponentJob(engine, AUTO_EDIT_MOMENTS, key);
  const status = job?.state === "running" || job?.state === "completing" ? "running" : "queued";
  const jobId = enqueued.jobId ?? job?.id;
  if (jobId == null) {
    throw new Error("Auto-edit analysis could not be queued.");
  }
  return { status, job_id: jobId };
}

export interface AutoEditRenderArgs {
  bookId: string;
  sourceArtifactId: string;
  notebookId: string | null;
  sourceHash: string;
  requestId: string;
  anchors?: AutoEditAnchors;
  sections?: AutoEditSections;
  plan?: SegmentPlan;
  cues?: AutoEditCue[];
}

export async function requestAutoEditRender(
  engine: Engine,
  input: AutoEditRenderArgs,
): Promise<{ status: "queued" | "completed"; job_id: number; output_asset_id: string }> {
  if (input.anchors !== undefined && input.plan !== undefined) {
    throw new Error("Give either anchors or plan, not both.");
  }
  const mode: "anchors" | "plan" = input.plan !== undefined ? "plan" : "anchors";
  const fingerprint = renderRequestFingerprint([
    input.sourceArtifactId,
    input.notebookId,
    input.sourceHash,
    mode,
    mode === "plan"
      ? { plan: input.plan, cues: input.cues ?? [] }
      : { anchors: input.anchors ?? null, sections: input.sections ?? null },
  ]);

  return withNotebookMutation(`auto-edit-render:${input.bookId}:${input.requestId}`, async () => {
    const existing = readAutoEditRenderRequest(engine, input.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error("This request ID belongs to a different auto-edit render. Start a new request.");
      }
      if (!engine.artifacts.get(existing.outputArtifactId).ok) {
        throw new Error("The auto-edit copy was deleted. Start a new request.");
      }
      if (renderRequestRunning(engine, existing) && existing.jobId !== null) {
        const job = engine.jobs.queue.get(existing.jobId);
        return {
          status: job?.state === "done" ? "completed" : "queued",
          job_id: existing.jobId,
          output_asset_id: existing.outputArtifactId,
        };
      }
    }

    const source = await readAutoEditSource(engine, input.sourceArtifactId, input.sourceHash);
    const segSource = segmentSourceOf(source);

    let resolvedPlan: SegmentPlan;
    let resolvedCues: AutoEditCue[];
    let savedAnchors: AutoEditAnchors | null = null;
    let savedSections: AutoEditSections | null = null;

    if (mode === "plan") {
      resolvedPlan = input.plan!;
      resolvedCues = input.cues ?? [];
      if (resolvedPlan.source.sourceHash !== source.sourceHash) {
        throw new Error("The plan's sourceHash does not match the current video file.");
      }
      const issues = checkSegmentPlan(resolvedPlan);
      if (issues.length > 0) {
        throw new Error(issues[0]!.message);
      }
    } else {
      const existingDraft = readStoredAutoEditDraft(engine, source.artifactId);
      const draftMatches = existingDraft !== null && existingDraft.sourceHash === source.sourceHash;
      const baseAnchors = input.anchors ?? (draftMatches ? existingDraft.anchors : defaultAnchors(segSource));
      const baseSections = input.sections ?? (draftMatches ? existingDraft.sections : { ...DEFAULT_AUTO_EDIT_SECTIONS });
      const built = buildAutoEditPlan(segSource, baseAnchors, baseSections);
      const issues = checkSegmentPlan(built.plan);
      if (issues.length > 0) {
        throw new Error(issues[0]!.message);
      }
      resolvedPlan = built.plan;
      resolvedCues = built.cues;
      savedAnchors = built.anchors;
      savedSections = baseSections;
    }

    checkAutoEditNotebook(engine, input.notebookId, source.artifactId);

    if (savedAnchors && savedSections) {
      saveAutoEditDraft(engine, source.artifactId, source.sourceHash, savedAnchors, savedSections);
    }

    let outputArtifactId = existing?.outputArtifactId;
    if (!outputArtifactId) {
      const created = await engine.artifacts.create({
        kind: "video",
        label: `${source.label ?? "Video"} — Auto-edit`,
      });
      if (!created.ok) throw new Error(created.error.message);
      outputArtifactId = created.value.artifactId;
    }

    const record: AutoEditRenderRequest = {
      requestId: input.requestId,
      fingerprint,
      sourceArtifactId: source.artifactId,
      outputArtifactId,
      notebookId: input.notebookId,
      sourceHash: source.sourceHash,
      mode,
      anchors: savedAnchors,
      sections: savedSections,
      plan: resolvedPlan,
      cues: resolvedCues,
      jobId: null,
      createdAt: new Date().toISOString(),
    };
    writeRenderSetting(engine, requestKey(record.requestId), record);
    indexRenderRequest(engine, requestIndexKey(record.sourceArtifactId), record.requestId);
    indexRenderRequest(engine, requestIndexKey(record.outputArtifactId), record.requestId);
    writeRenderSetting(engine, latestRenderKey(record.sourceArtifactId), record.requestId);

    const job = await queue.enqueue(`auto-edit-render-${record.requestId}-${randomUUID()}`, {
      type: AUTO_EDIT_RENDER_JOB,
      bookId: input.bookId,
      assetId: outputArtifactId,
      requestId: record.requestId,
    });
    writeRenderSetting(engine, requestKey(record.requestId), { ...record, jobId: job.id });
    return { status: "queued", job_id: job.id, output_asset_id: outputArtifactId };
  });
}
