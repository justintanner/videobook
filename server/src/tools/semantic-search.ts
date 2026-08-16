import type {
  Engine,
  EditIntent,
  IndexManifest,
  NotebookCell,
  PreparedSearchOptions,
  SearchHit,
  SearchQuery,
} from "videobook-engine";
import {
  firstEmptyNotebookGridSlot,
  findAudioFile,
  findPrimaryMediaFile,
  findVideoFile,
  isNotebookGridSlot,
  MVP_CONTRACT_VERSION,
  sourceTicksToSequenceFrames,
} from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { mutateNotebook } from "../notebook-mutations.js";
import {
  registerLocalClapSearchProvider,
  registerLocalClipSearchProvider,
} from "../local-search-models.js";
import { FFMPEG } from "../ffmpeg.js";
import type { BookManager } from "../book-manager.js";
import { queue } from "../queue.js";
import { searchReferenceStore } from "../search-reference-store.js";
import { extname, join } from "node:path";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { buildAssetList } from "./reconcile-project-work.js";
import {
  videoProxyMetadataMatches,
  type VideoProxyAssessment,
} from "../video-proxy.js";

const bookSchema = { book_id: z.string().uuid() };
const rationalSchema = z.object({
  numerator: z.number().int().positive(),
  denominator: z.number().int().positive(),
});
const sourceRangeSchema = z.object({
  streamId: z.string().min(1),
  objectHash: z.string().min(1),
  startTick: z.number().int().nonnegative(),
  durationTicks: z.number().int().positive(),
  timeBase: rationalSchema,
});
const sourcePointSchema = z.object({
  streamId: z.string().min(1),
  objectHash: z.string().min(1),
  tick: z.number().int().nonnegative(),
  timeBase: rationalSchema,
});
const searchReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), artifact: z.string().min(1) }),
  z.object({ kind: z.literal("frame"), source: sourcePointSchema }),
  z.object({ kind: z.literal("video"), range: sourceRangeSchema }),
  z.object({ kind: z.literal("audio"), range: sourceRangeSchema }),
]);
const searchLocationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("still"),
    artifactId: z.string().uuid(),
    sourcePath: z.string().min(1),
    objectHash: z.string().min(1),
  }),
  z.object({
    kind: z.literal("timed"),
    artifactId: z.string().uuid(),
    range: sourceRangeSchema,
  }),
  z.object({
    kind: z.literal("document"),
    artifactId: z.string().uuid(),
    sourcePath: z.string().min(1),
    objectHash: z.string().min(1),
    startUtf8Byte: z.number().int().nonnegative(),
    endUtf8Byte: z.number().int().positive(),
  }),
]);
const searchSignalSchema = z.object({
  kind: z.enum(["visual", "speech", "ocr", "audio", "metadata", "exact", "near"]),
  rank: z.number().int().positive(),
  score: z.number().optional(),
  explanation: z.string().optional(),
});
const searchQuerySchema = z.object({
  text: z.string().optional(),
  reference: searchReferenceSchema.optional(),
  modalities: z.array(z.enum([
    "auto",
    "visual",
    "speech",
    "ocr",
    "audio",
    "metadata",
  ])).optional(),
  artifactKinds: z.array(z.enum([
    "video",
    "image",
    "audio",
    "script",
    "character",
    "prompt",
    "scene",
    "final",
  ])).optional(),
  durationMs: z.object({
    min: z.number().nonnegative().optional(),
    max: z.number().nonnegative().optional(),
  }).optional(),
  orientations: z.array(z.enum(["landscape", "portrait", "square"])).optional(),
  labels: z.array(z.string().min(1)).optional(),
  sourceArtifactIds: z.array(z.string().uuid()).optional(),
  indexingStates: z.array(z.enum([
    "not-indexed",
    "partial",
    "ready",
    "stale",
    "failed",
    "unsupported",
  ])).optional(),
  createdAfter: z.number().int().nonnegative().optional(),
  createdBefore: z.number().int().nonnegative().optional(),
  minScore: z.number().min(0).max(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
  cursor: z.string().min(1).optional(),
});
const preparedReferenceFields = {
  reference_id: z.string().uuid().optional(),
  reference_range: z.object({
    start_seconds: z.number().nonnegative(),
    duration_seconds: z.number().positive().optional(),
  }).optional(),
};
const searchHitSchema = z.object({
  artifactId: z.string().uuid(),
  artifactLabel: z.string().min(1).optional(),
  artifactKind: z.enum([
    "video",
    "image",
    "audio",
    "script",
    "character",
    "prompt",
    "scene",
    "final",
  ]),
  location: searchLocationSchema,
  representativeTick: z.number().int().nonnegative().optional(),
  score: z.number(),
  signals: z.array(searchSignalSchema),
  excerpt: z.string().optional(),
  indexManifestIds: z.array(z.string().min(1)),
});
const roughCutBeatSchema = z.object({
  beat_id: z.string().min(1),
  text: z.string().min(1),
  timeline_start_frame: z.number().int().nonnegative(),
  duration_frames: z.number().int().positive(),
});
const indexManifestSchema = z.object({
  manifestId: z.string().min(1),
  provider: z.string().min(1),
  modelId: z.string().min(1),
  modelRevision: z.string().min(1),
  license: z.string().min(1).optional(),
  embeddingSpace: z.string().min(1),
  dimensions: z.number().int().positive(),
  modalities: z.array(z.enum([
    "visual",
    "speech",
    "ocr",
    "audio",
    "metadata",
  ])).min(1),
  supportedLanguages: z.array(z.string().min(1)),
  preprocessingVersion: z.string().min(1),
  extractorVersion: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function ingestReadiness(
  kind: string,
  phases: Record<string, string>,
  hasAudio: boolean,
): { state: "ready" | "partial" | "failed"; missingOutputs: string[] } {
  const required = kind === "image"
    ? ["source", "proxy", "visual", "ocr"]
    : kind === "audio"
      ? ["source", "probe", "waveform", "transcript", "audio"]
      : [
          "source",
          "probe",
          "proxy",
          ...(hasAudio ? ["waveform", "transcript", "audio"] : []),
          "visual",
          "ocr",
        ];
  const failed = required.filter((name) => phases[name] === "failed");
  const missingOutputs = required.filter((name) =>
    phases[name] !== "ready" && phases[name] !== "not-applicable");
  return {
    state: failed.length > 0
      ? "failed"
      : missingOutputs.length === 0 ? "ready" : "partial",
    missingOutputs,
  };
}

export function semanticSearchDefs(
  engine: Engine,
  books?: BookManager,
): ToolDef[] {
  return [
    ...(books ? [librarySearchDef(books)] : []),
    {
      name: "list_ingest_status",
      description: "List independent ingest and search-index phase states",
      scope: "book",
      schema: {
        ...bookSchema,
        limit: z.number().int().positive().max(500).optional(),
      },
      handler: async (args) => {
        const limit = Number(args.limit) || 200;
        const artifacts = engine.artifacts.list().slice(-limit).reverse();
        const statuses = await Promise.all(artifacts.map(async (artifact) => {
          const [manifest, streams, waveform, transcripts, coverage, proxyMetadata, legacyTranscript] = await Promise.all([
            engine.files.manifest(artifact.artifactId),
            Promise.resolve(engine.streams.list(artifact.artifactId)),
            engine.metadata.waveforms.read(artifact.artifactId),
            Promise.resolve(engine.transcripts.list(artifact.artifactId)),
            Promise.resolve(engine.temporalSearch.coverage(artifact.artifactId)),
            engine.metadata.artifacts.read<VideoProxyAssessment>(artifact.artifactId, "proxy"),
            engine.files.read(artifact.artifactId, ".analysis.gpt4otrans.json"),
          ]);
          const files = manifest.ok ? manifest.value.files : [];
          const sourceFile = artifact.kind === "video"
            ? findVideoFile(files.filter((file) => file.name !== "proxy.mp4"))
            : findPrimaryMediaFile(files, artifact.kind);
          const proxyFile = files.find((file) => file.name === "proxy.mp4");
          const hasValidVideoProxy = sourceFile !== null
            && proxyFile !== undefined
            && proxyMetadata.ok
            && videoProxyMetadataMatches(proxyMetadata.value, sourceFile, proxyFile);
          const modalities = coverage.ok ? coverage.value.modalities : [];
          const phase = (name: string) =>
            modalities.find((item) => item.modality === name)?.state ?? "not-indexed";
          const hasAudio = streams.ok && streams.value.some((stream) => stream.kind === "audio");
          const phases = {
            source: files.length > 0 ? "ready" : "failed",
            probe: streams.ok && streams.value.length > 0
              ? "ready"
              : artifact.kind === "image" ? "not-applicable" : "not-indexed",
            proxy: (artifact.kind === "video"
              ? hasValidVideoProxy
              : files.some((file) =>
                /^original\.(?:jpe?g|png|webp|gif|svg|mp3|wav|m4a|weba|ogg|aac|flac)$/i
                  .test(file.name)))
              ? "ready"
              : "not-indexed",
            waveform: waveform.ok && waveform.value.peaks.length > 0
              ? "ready"
              : artifact.kind === "image" || !hasAudio ? "not-applicable" : "not-indexed",
            transcript: transcripts.ok && transcripts.value.length > 0
            || legacyTranscript.ok
              ? "ready"
              : artifact.kind === "image" || !hasAudio ? "not-applicable" : "not-indexed",
            visual: phase("visual"),
            audio: artifact.kind === "image" || !hasAudio ? "not-applicable" : phase("audio"),
            ocr: phase("ocr"),
          };
          const readiness = ingestReadiness(artifact.kind, phases, hasAudio);
          return {
            artifactId: artifact.artifactId,
            ...(artifact.label ? { label: artifact.label } : {}),
            kind: artifact.kind,
            state: readiness.state,
            missingOutputs: readiness.missingOutputs,
            phases,
            ...(coverage.ok ? { coverage: coverage.value } : {}),
          };
        }));
        return json(statuses);
      },
    },
    {
      name: "retry_ingest",
      description: "Retry derivation jobs without uploading source bytes again",
      scope: "book",
      schema: { ...bookSchema, artifact_id: z.string().uuid() },
      handler: async (args) => {
        const artifact = engine.artifacts.get(String(args.artifact_id));
        if (!artifact.ok) return failure(artifact.error.message);
        const manifest = await engine.files.manifest(artifact.value.artifactId);
        if (!manifest.ok) return failure(manifest.error.message);
        const source = artifact.value.kind === "video"
          ? findVideoFile(manifest.value.files)
          : artifact.value.kind === "audio"
            ? findAudioFile(manifest.value.files, artifact.value.kind)
            : manifest.value.files.find((file) =>
                /^original\.(?:jpe?g|png|webp|gif|svg)$/i.test(file.name));
        if (!source) return failure("No source file is available for retry");
        const jobId = `retry-ingest-${artifact.value.artifactId}-${Date.now()}`;
        const common = {
          assetId: artifact.value.artifactId,
          assetDir: artifact.value.path,
          bookId: engine.book.get().bookId,
          provenance: { origin: "retry-ingest" },
        };
        const payload = artifact.value.kind === "video"
          ? {
              type: "process_video",
              videoPath: join(artifact.value.path, source.name),
              force: true,
              preserveAudioArtifacts: true,
              ...common,
            }
          : artifact.value.kind === "audio"
            ? {
                type: "process_audio",
                audioPath: join(artifact.value.path, source.name),
                sourceFilename: source.name,
                ...common,
              }
            : {
                type: "process_image",
                extension: extname(source.name).toLowerCase(),
                ...common,
              };
        const queued = await queue.enqueue(
          jobId,
          payload as unknown as Record<string, unknown>,
        );
        return json({
          jobId: queued.id,
          operationId: queued.operationId,
          requestId: jobId,
          artifactId: artifact.value.artifactId,
        });
      },
    },
    {
      name: "search_moments",
      description: "Search indexed book moments with text, media references, and filters",
      scope: "book",
      schema: {
        ...bookSchema,
        query: searchQuerySchema,
        ...preparedReferenceFields,
      },
      handler: async (args) => {
        registerLocalClipSearchProvider(engine);
        registerLocalClapSearchProvider(engine, FFMPEG);
        const query = args.query as SearchQuery;
        const referenceId = typeof args.reference_id === "string"
          ? args.reference_id
          : undefined;
        const result = referenceId
          ? await engine.temporalSearch.queryPrepared(
              query,
              searchReferenceStore.get(referenceId).reference,
              preparedSearchOptions(args.reference_range),
            )
          : await engine.temporalSearch.query(query);
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "suggest_sequence_coverage",
      description: "Rank existing visual moments for a sequence range before offering generation",
      scope: "book",
      schema: {
        ...bookSchema,
        text: z.string().min(1),
        timeline_start_frame: z.number().int().nonnegative(),
        duration_frames: z.number().int().positive(),
        exclude_artifact_ids: z.array(z.string().uuid()).optional(),
        limit: z.number().int().positive().max(20).optional(),
      },
      handler: async (args) => {
        registerLocalClipSearchProvider(engine);
        const excluded = new Set(
          Array.isArray(args.exclude_artifact_ids)
            ? args.exclude_artifact_ids.map(String)
            : [],
        );
        const result = await engine.temporalSearch.query({
          text: String(args.text),
          modalities: ["visual", "metadata"],
          artifactKinds: ["video", "image"],
          limit: Math.min(100, (Number(args.limit) || 5) + excluded.size),
        });
        if (!result.ok) return failure(result.error.message);
        const hits = result.value.hits
          .filter((hit) => !excluded.has(hit.artifactId))
          .slice(0, Number(args.limit) || 5);
        return json({
          kind: "coverage-suggestions",
          existingFirst: true,
          query: { text: String(args.text) },
          destination: {
            sequenceId: engine.sequences.getPrimary().sequenceId,
            timelineStartFrame: Number(args.timeline_start_frame),
            durationFrames: Number(args.duration_frames),
          },
          hits,
          coverage: result.value.coverage,
          generationFallback: hits.length === 0
            ? {
                offered: true,
                reason: "No indexed existing moment met the coverage request",
              }
            : { offered: false },
        });
      },
    },
    {
      name: "plan_notebook_rough_cut",
      description: "Map narration beats to non-repeating indexed visuals as a reviewable CommandPlan",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        source_surface: z.enum(["ui", "slash", "chat"]),
        actor: z.string().min(1),
        beats: z.array(roughCutBeatSchema).min(1).max(20),
        track_id: z.string().uuid().optional(),
        min_shot_frames: z.number().int().positive().optional(),
        max_shot_frames: z.number().int().positive().optional(),
        max_repeats_per_artifact: z.number().int().positive().max(3).optional(),
      },
      handler: async (args) => {
        const notebook = engine.notebooks.read(String(args.notebook_id));
        if (!notebook.ok) return failure(notebook.error.message);
        const sequence = engine.sequences.getPrimary();
        const requestedTrackId = typeof args.track_id === "string"
          ? args.track_id
          : undefined;
        const videoTracks = sequence.tracks
          .filter((track) =>
            track.kind === "video" && track.enabled && !track.locked)
          .sort((left, right) => left.ordinal - right.ordinal);
        const track = requestedTrackId
          ? videoTracks.find((candidate) => candidate.trackId === requestedTrackId)
          : videoTracks[1] ?? videoTracks[0];
        if (!track) return failure("No editable video track is available");
        const minShotFrames = Number(args.min_shot_frames) || 1;
        const maxShotFrames = Number(args.max_shot_frames) || 120;
        if (maxShotFrames < minShotFrames) {
          return failure("Maximum shot duration must be at least the minimum");
        }
        const maxRepeats = Number(args.max_repeats_per_artifact) || 1;
        const beats = args.beats as z.infer<typeof roughCutBeatSchema>[];
        const usage = new Map<string, number>();
        const selected = [];
        const uncovered = [];
        registerLocalClipSearchProvider(engine);
        for (const beat of beats) {
          const search = await engine.temporalSearch.query({
            text: beat.text,
            modalities: ["visual", "metadata"],
            artifactKinds: ["video", "image"],
            limit: 20,
          });
          if (!search.ok) return failure(search.error.message);
          const hit = search.value.hits.find((candidate) =>
            (usage.get(candidate.artifactId) ?? 0) < maxRepeats);
          if (!hit) {
            uncovered.push({
              beatId: beat.beat_id,
              text: beat.text,
              reason: "No unused indexed visual moment is available",
            });
            continue;
          }
          usage.set(hit.artifactId, (usage.get(hit.artifactId) ?? 0) + 1);
          const durationFrames = Math.max(
            minShotFrames,
            Math.min(maxShotFrames, beat.duration_frames),
          );
          const sourceDurationFrames = hit.location.kind === "timed"
            ? hitDurationFrames(hit, sequence.frameRate, durationFrames)
            : durationFrames;
          selected.push({
            beat,
            hit,
            operation: {
              kind: "insert-clip" as const,
              mode: "overwrite" as const,
              placement: {
                trackId: track.trackId,
                timelineStartFrame: beat.timeline_start_frame,
                durationFrames,
                source: hit.location.kind === "timed"
                  ? {
                      kind: "timed" as const,
                      artifactId: hit.artifactId,
                      range: hit.location.range,
                    }
                  : {
                      kind: "still" as const,
                      artifactId: hit.artifactId,
                      sourcePath: hit.location.sourcePath,
                      objectHash: hit.location.objectHash,
                    },
                ...(hit.location.kind === "timed"
                  ? {
                      speed: {
                        numerator: sourceDurationFrames,
                        denominator: durationFrames,
                      },
                      reverse: false,
                      audioPolicy: "mute" as const,
                    }
                  : {}),
              },
            },
          });
        }
        if (selected.length === 0) {
          return json({
            kind: "rough-cut-uncovered",
            existingFirst: true,
            uncoveredBeats: uncovered,
            generationFallback: {
              offered: true,
              reason: "No indexed existing moments can cover these beats",
            },
          });
        }
        const planId = uuidv7();
        const intent: EditIntent = {
          intentVersion: MVP_CONTRACT_VERSION,
          commandId: planId,
          sequenceId: sequence.sequenceId,
          baseRevision: engine.head,
          actor: String(args.actor),
          sourceSurface: args.source_surface as "ui" | "slash" | "chat",
          confirmationPolicy: "always",
          operations: selected.map((item) => item.operation),
        };
        return json({
          planVersion: 1,
          planId,
          sourceSurface: args.source_surface,
          actor: String(args.actor),
          bookId: engine.book.get().bookId,
          summary: `Cover ${selected.length} narration beats with existing media`,
          normalizedReferences: [{
            kind: "notebook",
            targetId: notebook.value.id,
            revision: engine.head,
          }, {
            kind: "sequence",
            targetId: sequence.sequenceId,
            revision: engine.head,
          }],
          suggestions: selected.map((item) => ({
            suggestionId: item.beat.beat_id,
            label: item.beat.text,
            beatId: item.beat.beat_id,
            query: item.beat.text,
            destination: {
              timelineStartFrame: item.operation.placement.timelineStartFrame,
              durationFrames: item.operation.placement.durationFrames,
            },
            hit: item.hit,
            included: true,
            operation: item.operation,
          })),
          uncoveredBeats: uncovered,
          generationFallback: {
            offered: uncovered.length > 0,
            reason: uncovered.length > 0
              ? "Some beats have no unused indexed visual coverage"
              : undefined,
          },
          stages: [{
            stageId: `${planId}:edit:0`,
            kind: "edit",
            summary: `Overwrite ${selected.length} coverage ranges`,
            intent,
          }],
          confirmation: {
            required: true,
            policy: "always",
            reason: "Review every selected source moment before applying the rough cut",
          },
        });
      },
    },
    {
      name: "plan_sequence_sound_effects",
      description: "Suggest existing indexed audio moments for timed story beats as a selectable CommandPlan",
      scope: "book",
      schema: {
        ...bookSchema,
        source_surface: z.enum(["ui", "slash", "chat"]),
        actor: z.string().min(1),
        moments: z.array(roughCutBeatSchema).min(1).max(20),
        track_id: z.string().uuid().optional(),
        max_repeats_per_artifact: z.number().int().positive().max(3).optional(),
      },
      handler: async (args) => {
        const sequence = engine.sequences.getPrimary();
        const requestedTrackId = typeof args.track_id === "string"
          ? args.track_id
          : undefined;
        const audioTracks = sequence.tracks
          .filter((track) =>
            track.kind === "audio" && track.enabled && !track.locked)
          .sort((left, right) => left.ordinal - right.ordinal);
        const track = requestedTrackId
          ? audioTracks.find((candidate) => candidate.trackId === requestedTrackId)
          : audioTracks[1] ?? audioTracks[0];
        if (!track) return failure("No editable audio track is available");
        const maxRepeats = Number(args.max_repeats_per_artifact) || 1;
        const usage = new Map<string, number>();
        const selected = [];
        const uncovered = [];
        registerLocalClapSearchProvider(engine, FFMPEG);
        for (const moment of args.moments as z.infer<typeof roughCutBeatSchema>[]) {
          const search = await engine.temporalSearch.query({
            text: moment.text,
            modalities: ["audio", "metadata"],
            artifactKinds: ["audio"],
            limit: 20,
          });
          if (!search.ok) return failure(search.error.message);
          const hit = search.value.hits.find((candidate) =>
            candidate.location.kind === "timed"
            && (usage.get(candidate.artifactId) ?? 0) < maxRepeats);
          if (!hit || hit.location.kind !== "timed") {
            uncovered.push({
              beatId: moment.beat_id,
              text: moment.text,
              reason: "No unused indexed sound moment is available",
            });
            continue;
          }
          usage.set(hit.artifactId, (usage.get(hit.artifactId) ?? 0) + 1);
          const durationFrames = Math.max(
            1,
            Math.min(
              moment.duration_frames,
              hitDurationFrames(hit, sequence.frameRate, moment.duration_frames),
            ),
          );
          const operation = {
            kind: "insert-clip" as const,
            mode: "overwrite" as const,
            placement: {
              trackId: track.trackId,
              timelineStartFrame: moment.timeline_start_frame,
              durationFrames,
              source: {
                kind: "timed" as const,
                artifactId: hit.artifactId,
                range: hit.location.range,
              },
              speed: { numerator: 1, denominator: 1 },
              reverse: false,
              audioPolicy: "preserve-pitch" as const,
              audio: {
                gainDb: -6,
                muted: false,
                fadeInFrames: Math.min(3, durationFrames - 1),
                fadeOutFrames: Math.min(3, durationFrames - 1),
              },
            },
          };
          selected.push({ moment, hit, operation });
        }
        if (selected.length === 0) {
          return json({
            kind: "sound-effects-uncovered",
            existingFirst: true,
            uncoveredBeats: uncovered,
            generationFallback: {
              offered: true,
              reason: "No indexed existing sound can cover these beats",
            },
          });
        }
        const planId = uuidv7();
        const actor = String(args.actor);
        const sourceSurface = args.source_surface as "ui" | "slash" | "chat";
        const intent: EditIntent = {
          intentVersion: MVP_CONTRACT_VERSION,
          commandId: planId,
          sequenceId: sequence.sequenceId,
          baseRevision: engine.head,
          actor,
          sourceSurface,
          confirmationPolicy: "always",
          operations: selected.map((item) => item.operation),
        };
        return json({
          planVersion: 1,
          planId,
          sourceSurface,
          actor,
          bookId: engine.book.get().bookId,
          summary: `Review ${selected.length} existing sound-effect suggestions`,
          normalizedReferences: [{
            kind: "sequence",
            targetId: sequence.sequenceId,
            revision: engine.head,
          }],
          suggestions: selected.map((item) => ({
            suggestionId: item.moment.beat_id,
            label: item.moment.text,
            detail: item.hit.artifactLabel ?? item.hit.artifactId,
            category: "sound-effect",
            included: true,
            hit: item.hit,
            operation: item.operation,
          })),
          uncoveredBeats: uncovered,
          generationFallback: {
            offered: uncovered.length > 0,
            reason: uncovered.length > 0
              ? "Some beats have no unused indexed sound coverage"
              : undefined,
          },
          stages: [{
            stageId: `${planId}:edit:0`,
            kind: "edit",
            summary: `Overwrite ${selected.length} sound-effect ranges`,
            intent,
          }],
          confirmation: {
            required: true,
            policy: "always",
            reason: "Review each sound and mix placement before applying",
          },
        });
      },
    },
    {
      name: "get_search_coverage",
      description: "Read progressive semantic-index coverage for a book or artifact",
      scope: "book",
      schema: { ...bookSchema, artifact_id: z.string().uuid().optional() },
      handler: async (args) => {
        const artifact = typeof args.artifact_id === "string"
          ? args.artifact_id
          : undefined;
        const result = engine.temporalSearch.coverage(artifact);
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "get_search_index_status",
      description: "Read temporal search manifests, providers, and index statistics",
      scope: "book",
      schema: bookSchema,
      handler: async () => json({
        manifests: engine.temporalSearch.manifests.list(),
        providers: engine.temporalSearch.providers.list(),
        stats: engine.temporalSearch.stats(),
      }),
    },
    {
      name: "list_media_streams",
      description: "List typed media streams for a source artifact",
      scope: "book",
      schema: { ...bookSchema, artifact_id: z.string().uuid() },
      handler: async (args) => {
        const result = engine.streams.list(String(args.artifact_id));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "register_search_manifest",
      description: "Register an immutable semantic-index model manifest",
      scope: "book",
      schema: { ...bookSchema, manifest: indexManifestSchema },
      handler: async (args) => {
        const result = engine.temporalSearch.manifests.register(
          args.manifest as IndexManifest,
        );
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "pin_search_moment",
      description: "Pin a revision-stable search moment into a notebook media selection cell",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid().optional(),
        cell_label: z.string().min(1).optional()
          .describe("Optional free-text display label for a newly created cell"),
        slot: z.object({
          row: z.number().int().min(0).max(25),
          column: z.number().int().min(0).max(12),
        }).optional(),
        query: searchQuerySchema,
        hit: searchHitSchema,
      },
      handler: async (args) => {
        const hit = args.hit as SearchHit;
        const query = args.query as SearchQuery;
        const cellId = typeof args.cell_id === "string"
          ? args.cell_id
          : uuidv7();
        const pinnedResult = {
          id: uuidv7(),
          artifactId: hit.artifactId,
          objectHash: objectHashForHit(hit),
          location: hit.location,
          ...(hit.representativeTick === undefined
            ? {}
            : { representativeTick: hit.representativeTick }),
          query,
          signals: hit.signals,
          selectedRevision: engine.head,
          ordinal: 0,
          createdAt: Date.now(),
        };
        let pinnedCell: NotebookCell | undefined;
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "pin_search_moment",
          (notebook) => {
            const existing = notebook.cells.find((cell) => cell.id === cellId);
            if (existing) {
              const pinnedResults = [
                ...(existing.pinnedResults ?? []),
                {
                  ...pinnedResult,
                  ordinal: existing.pinnedResults?.length ?? 0,
                },
              ];
              pinnedCell = { ...existing, pinnedResults };
              return {
                ...notebook,
                cells: notebook.cells.map((cell) =>
                  cell.id === cellId ? pinnedCell! : cell
                ),
              };
            }
            const created: NotebookCell = {
              id: cellId,
              type: hit.artifactKind === "audio"
                ? "audio"
                : hit.location.kind === "timed"
                  ? "video"
                  : "image",
              ...(typeof args.cell_label === "string" && args.cell_label.trim()
                ? { label: args.cell_label.trim() }
                : {}),
              slot: isSlot(args.slot)
                ? args.slot
                : firstEmptyNotebookSlot(notebook),
              references: [{
                id: uuidv7(),
                kind: "artifact",
                targetId: hit.artifactId,
                snapshot: {
                  objectHash: pinnedResult.objectHash,
                  ...(hit.artifactLabel
                    ? { artifactLabel: hit.artifactLabel }
                    : {}),
                },
                ordinal: 0,
              }],
              pinnedResults: [pinnedResult],
              inputs: {
                selectionKind: "semantic-search",
                ...(hit.location.kind === "timed"
                  ? {
                      startSeconds: hit.location.range.startTick
                        * hit.location.range.timeBase.numerator
                        / hit.location.range.timeBase.denominator,
                      endSeconds: (
                        hit.location.range.startTick
                        + hit.location.range.durationTicks
                      ) * hit.location.range.timeBase.numerator
                        / hit.location.range.timeBase.denominator,
                    }
                  : {}),
              },
            };
            pinnedCell = created;
            return {
              ...notebook,
              cells: [...notebook.cells, created],
            };
          },
          { cellId, artifactId: hit.artifactId },
        );
        return result.ok
          ? json({ cell: pinnedCell, revision: result.value.hash })
          : failure(result.error.message);
      },
    },
    {
      name: "send_search_moment_to_sequence",
      description: "Append one search moment to the primary sequence as a reversible edit",
      scope: "book",
      schema: {
        ...bookSchema,
        hit: searchHitSchema,
        timeline_start_frame: z.number().int().nonnegative().optional(),
        still_duration_frames: z.number().int().positive().optional(),
      },
      handler: async (args) => {
        const hit = args.hit as SearchHit;
        const sequence = engine.sequences.getPrimary();
        const trackKind = hit.artifactKind === "audio" ? "audio" : "video";
        const track = sequence.tracks.find((candidate) =>
          candidate.kind === trackKind && candidate.enabled && !candidate.locked
        );
        if (!track) return failure(`No editable ${trackKind} track is available`);
        const durationFrames = hit.location.kind === "timed"
          ? sourceTicksToSequenceFrames(
              hit.location.range.durationTicks,
              hit.location.range.timeBase,
              sequence.frameRate,
              "ceil",
            )
          : typeof args.still_duration_frames === "number"
            ? args.still_duration_frames
            : 90;
        const timelineStartFrame = typeof args.timeline_start_frame === "number"
          ? args.timeline_start_frame
          : sequence.clips
              .filter((clip) => clip.trackId === track.trackId)
              .reduce(
                (end, clip) =>
                  Math.max(end, clip.timelineStartFrame + clip.durationFrames),
                0,
              );
        const intent: EditIntent = {
          intentVersion: MVP_CONTRACT_VERSION,
          commandId: uuidv7(),
          sequenceId: sequence.sequenceId,
          baseRevision: engine.head,
          actor: "videobook-ui",
          sourceSurface: "ui",
          confirmationPolicy: "reversible-single-step",
          operations: [{
            kind: "insert-clip",
            mode: "insert",
            placement: {
              trackId: track.trackId,
              timelineStartFrame,
              durationFrames,
              source: hit.location.kind === "timed"
                ? {
                    kind: "timed",
                    artifactId: hit.artifactId,
                    range: hit.location.range,
                  }
                : {
                    kind: "still",
                    artifactId: hit.artifactId,
                    sourcePath: hit.location.sourcePath,
                    objectHash: hit.location.objectHash,
                  },
              ...(hit.location.kind === "timed"
                ? {
                    speed: { numerator: 1, denominator: 1 },
                    reverse: false,
                    audioPolicy: "preserve-pitch" as const,
                  }
                : {}),
            },
          }],
        };
        const preview = engine.edits.preview(intent);
        if (!preview.ok) return failure(preview.error.message);
        if (!preview.value.valid) return json({ preview: preview.value });
        const committed = await engine.edits.commit(
          intent,
          preview.value.previewHash,
        );
        return committed.ok
          ? json({ preview: preview.value, commit: committed.value })
          : failure(committed.error.message);
      },
    },
    {
      name: "list_sequence_replace_targets",
      description: "List clips that a search moment can explicitly replace",
      scope: "book",
      schema: bookSchema,
      handler: async () => {
        const sequence = engine.sequences.getPrimary();
        const tracks = new Map(sequence.tracks.map((track) => [track.trackId, track]));
        return json({
          sequenceId: sequence.sequenceId,
          revision: sequence.revision,
          targets: sequence.clips.map((clip) => ({
            clipId: clip.clipId,
            trackId: clip.trackId,
            trackKind: tracks.get(clip.trackId)?.kind ?? "unknown",
            timelineStartFrame: clip.timelineStartFrame,
            durationFrames: clip.durationFrames,
            artifactId: clip.source.artifactId,
          })),
        });
      },
    },
    {
      name: "replace_sequence_clip_with_search_moment",
      description: "Preview, then confirm, replacing one explicit sequence clip with a search moment",
      scope: "book",
      schema: {
        ...bookSchema,
        hit: searchHitSchema,
        clip_id: z.string().uuid(),
        command_id: z.string().uuid().optional(),
        base_revision: z.string().min(1).optional(),
        preview_hash: z.string().min(1).optional(),
      },
      handler: async (args) => {
        const hit = args.hit as SearchHit;
        const sequence = engine.sequences.getPrimary();
        const target = sequence.clips.find((clip) => clip.clipId === args.clip_id);
        if (!target) return failure(`Sequence clip not found: ${String(args.clip_id)}`);
        const track = sequence.tracks.find((candidate) => candidate.trackId === target.trackId);
        if (!track || track.locked || !track.enabled) {
          return failure("The target clip is not on an editable track");
        }
        const expectedKind = hit.artifactKind === "audio" ? "audio" : "video";
        if (track.kind !== expectedKind) {
          return failure(`A ${hit.artifactKind} result cannot replace a ${track.kind} clip`);
        }
        const durationFrames = hitDurationFrames(hit, sequence.frameRate, target.durationFrames);
        const commandId = typeof args.command_id === "string"
          ? args.command_id
          : uuidv7();
        const intent: EditIntent = {
          intentVersion: MVP_CONTRACT_VERSION,
          commandId,
          sequenceId: sequence.sequenceId,
          baseRevision: typeof args.base_revision === "string"
            ? args.base_revision
            : engine.head,
          actor: "videobook-ui",
          sourceSurface: "ui",
          confirmationPolicy: "always",
          operations: [{
            kind: "batch-replace-range",
            range: {
              sequenceId: sequence.sequenceId,
              startFrame: target.timelineStartFrame,
              durationFrames: target.durationFrames,
            },
            trackIds: [target.trackId],
            placements: [{
              trackId: target.trackId,
              timelineStartFrame: target.timelineStartFrame,
              durationFrames,
              source: hit.location.kind === "timed"
                ? {
                    kind: "timed",
                    artifactId: hit.artifactId,
                    range: hit.location.range,
                  }
                : {
                    kind: "still",
                    artifactId: hit.artifactId,
                    sourcePath: hit.location.sourcePath,
                    objectHash: hit.location.objectHash,
                  },
              ...(hit.location.kind === "timed"
                ? {
                    speed: { numerator: 1, denominator: 1 },
                    reverse: false,
                    audioPolicy: "preserve-pitch" as const,
                  }
                : {}),
            }],
            ripple: false,
          }],
        };
        const preview = engine.edits.preview(intent);
        if (!preview.ok) return failure(preview.error.message);
        if (typeof args.preview_hash !== "string") {
          return json({
            confirmationRequired: true,
            commandId,
            baseRevision: intent.baseRevision,
            preview: preview.value,
          });
        }
        if (args.preview_hash !== preview.value.previewHash) {
          return failure("The replacement preview changed; review the latest preview");
        }
        if (!preview.value.valid) {
          return json({
            confirmationRequired: true,
            commandId,
            baseRevision: intent.baseRevision,
            preview: preview.value,
          });
        }
        const committed = await engine.edits.commit(intent, preview.value.previewHash);
        return committed.ok
          ? json({ preview: preview.value, commit: committed.value })
          : failure(committed.error.message);
      },
    },
  ];
}

function librarySearchDef(books: BookManager): ToolDef {
  return {
    name: "search_library_moments",
    description: "Federate a moment search across every current-schema book",
    scope: "global",
    schema: {
      query: searchQuerySchema,
      ...preparedReferenceFields,
    },
    handler: async (args) => {
      await books.ready();
      const query = args.query as SearchQuery;
      const referenceId = typeof args.reference_id === "string"
        ? args.reference_id
        : undefined;
      const prepared = referenceId
        ? searchReferenceStore.get(referenceId).reference
        : undefined;
      const preparedOptions = preparedSearchOptions(args.reference_range);
      const pages = await Promise.all(books.list().map(async (summary) => {
        const managed = books.get(summary.bookId);
        if (!managed.ok) {
          return { summary, error: managed.error.message };
        }
        registerLocalClipSearchProvider(managed.value.engine);
        registerLocalClapSearchProvider(managed.value.engine, FFMPEG);
        const bookQuery = {
          ...query,
          cursor: undefined,
          limit: Math.min(query.limit ?? 30, 100),
        };
        const result = prepared
          ? await managed.value.engine.temporalSearch.queryPrepared(
              bookQuery,
              prepared,
              preparedOptions,
            )
          : await managed.value.engine.temporalSearch.query(bookQuery);
        if (!result.ok) return { summary, error: result.error.message };
        const assets = await buildAssetList(
          managed.value.engine,
          summary.bookId,
          "newest",
        ).catch(() => []);
        const assetById = new Map(
          assets.map((asset) => [asset.artifact_id, asset]),
        );
        return {
          summary,
          page: {
            ...result.value,
            hits: result.value.hits.map((hit) => {
              const asset = assetById.get(hit.artifactId);
              return {
                ...hit,
                mediaUrl: asset?.media_url ?? null,
                thumbnailUrl: asset?.thumbnail_url ?? null,
              };
            }),
          },
        };
      }));
      const hits = pages.flatMap((entry) =>
        entry.page?.hits.map((hit, index) => ({
          ...hit,
          score: 1 / (60 + index + 1),
          owningBookId: entry.summary.bookId,
          owningBookName: entry.summary.name,
        })) ?? []);
      hits.sort((left, right) =>
        right.score - left.score
        || left.owningBookName.localeCompare(right.owningBookName)
        || left.artifactId.localeCompare(right.artifactId)
        || JSON.stringify(left.location).localeCompare(JSON.stringify(right.location)));
      const limit = Math.min(query.limit ?? 30, 100);
      return json({
        hits: hits.slice(0, limit),
        coverage: {
          state: pages.some((entry) => entry.error || entry.page?.coverage.partialResults)
            ? "partial"
            : "ready",
          partialResults: pages.some((entry) =>
            Boolean(entry.error || entry.page?.coverage.partialResults)),
          indexedArtifactCount: pages.reduce(
            (sum, entry) => sum + (entry.page?.coverage.indexedArtifactCount ?? 0),
            0,
          ),
          totalArtifactCount: pages.reduce(
            (sum, entry) => sum + (entry.page?.coverage.totalArtifactCount ?? 0),
            0,
          ),
          books: pages.map((entry) => ({
            bookId: entry.summary.bookId,
            name: entry.summary.name,
            ...(entry.page ? { coverage: entry.page.coverage } : {}),
            ...(entry.error ? { error: entry.error } : {}),
          })),
        },
      });
    },
  };
}

function preparedSearchOptions(value: unknown): PreparedSearchOptions {
  if (typeof value !== "object" || value === null) return {};
  const range = value as Record<string, unknown>;
  if (typeof range.start_seconds !== "number") return {};
  return {
    range: {
      startMs: range.start_seconds * 1_000,
      ...(typeof range.duration_seconds === "number"
        ? { durationMs: range.duration_seconds * 1_000 }
        : {}),
    },
  };
}

function objectHashForHit(hit: SearchHit): string {
  return hit.location.kind === "timed"
    ? hit.location.range.objectHash
    : hit.location.objectHash;
}

function hitDurationFrames(
  hit: SearchHit,
  frameRate: { numerator: number; denominator: number },
  stillDurationFrames: number,
): number {
  return hit.location.kind === "timed"
    ? sourceTicksToSequenceFrames(
        hit.location.range.durationTicks,
        hit.location.range.timeBase,
        frameRate,
        "ceil",
      )
    : stillDurationFrames;
}

function isSlot(value: unknown): value is { row: number; column: number } {
  if (typeof value !== "object" || value === null) return false;
  const slot = value as Record<string, unknown>;
  return Number.isSafeInteger(slot.row)
    && Number.isSafeInteger(slot.column)
    && isNotebookGridSlot({
      row: Number(slot.row),
      column: Number(slot.column),
    });
}

function firstEmptyNotebookSlot(notebook: {
  cells: NotebookCell[];
}): { row: number; column: number } {
  return firstEmptyNotebookGridSlot(
    notebook.cells.map((cell) => cell.slot),
  );
}
