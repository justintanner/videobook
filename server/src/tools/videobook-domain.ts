import type {
  ClipPlacement,
  CaptionTrack,
  EditIntent,
  EditOperation,
  Engine,
  EntityDocument,
  EntityType,
  NotebookCell,
  NotebookCellReference,
  NotebookCellType,
  NotebookDocument,
  PinnedSearchResult,
  Sequence,
  SourceRange,
  TimedSequenceClip,
  Transcript,
} from "videobook-engine";
import {
  MVP_CONTRACT_VERSION,
  sequenceFramesToSourceTicks,
  sourceRangeEndTick,
  sourceTicksToSequenceFrames,
} from "videobook-engine";
import { z } from "zod";
import { v5 as uuidv5, v7 as uuidv7 } from "uuid";
import type { BookManager } from "../book-manager.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { queue, stopBookQueue } from "../queue.js";
import { prepareNotebookGeneration } from "../jobs/run-notebook.js";
import {
  buildGenerationInsertPlan,
  continueQueuedInsert,
} from "./command-plan.js";
import { estimateCostDef } from "./estimate-cost.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import {
  listNotebookActions,
  markDescendantsStale,
  normalizeCellActionFields,
  selectedCellDetails,
  validateCellConfiguration,
} from "../notebook-action-catalog.js";
import { buildSevenStageScaffold } from "../notebook-workflow.js";

const bookSchema = { book_id: z.string().uuid() };
const cellTypeSchema = z.enum([
  "source",
  "audio",
  "transcript",
  "note",
  "search",
  "selects",
  "prompt",
  "character",
  "scene",
  "asset",
  "image",
  "video",
  "sequence",
  "analysis",
  "split",
  "frame",
  "export",
]);
const cellReferenceSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum([
    "artifact",
    "stream",
    "source-range",
    "transcript",
    "sequence",
    "cell-output",
  ]),
  target_id: z.string().min(1),
  snapshot: z.record(z.string(), z.unknown()),
  ordinal: z.number().int().nonnegative(),
});
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
const searchQuerySchema = z.record(z.string(), z.unknown());
const searchSignalSchema = z.object({
  kind: z.enum(["visual", "speech", "ocr", "audio", "metadata", "exact", "near"]),
  rank: z.number().int().positive(),
  score: z.number().optional(),
  explanation: z.string().optional(),
});
const pinnedSearchResultSchema = z.object({
  id: z.string().uuid(),
  artifact_id: z.string().uuid(),
  object_hash: z.string().min(1),
  location: searchLocationSchema,
  representative_tick: z.number().int().nonnegative().optional(),
  query: searchQuerySchema,
  signals: z.array(searchSignalSchema),
  selected_revision: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
});
const cellInputSchema = z.object({
  type: cellTypeSchema,
  title: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }),
  entity_id: z.string().uuid().optional(),
  prompt: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  operation: z.string().optional(),
  tool: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  output_artifact_id: z.string().uuid().optional(),
  references: z.array(cellReferenceSchema).optional(),
  pinned_results: z.array(pinnedSearchResultSchema).optional(),
});

type CellInput = z.infer<typeof cellInputSchema>;

function referenceFromInput(
  input: z.infer<typeof cellReferenceSchema>,
): NotebookCellReference {
  return {
    id: input.id,
    kind: input.kind,
    targetId: input.target_id,
    snapshot: input.snapshot,
    ordinal: input.ordinal,
  };
}

function pinnedResultFromInput(
  input: z.infer<typeof pinnedSearchResultSchema>,
): PinnedSearchResult {
  return {
    id: input.id,
    artifactId: input.artifact_id,
    objectHash: input.object_hash,
    location: input.location,
    ...(input.representative_tick === undefined
      ? {}
      : { representativeTick: input.representative_tick }),
    query: input.query,
    signals: input.signals,
    selectedRevision: input.selected_revision,
    ordinal: input.ordinal,
    createdAt: input.created_at,
  };
}

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

type GenerationPlanStatus =
  | "planned"
  | "queued"
  | "awaiting-output"
  | "failed"
  | "omitted"
  | "continued";

type NotebookGenerationPlanRecord = {
  planId: string;
  cellId: string;
  status: GenerationPlanStatus;
  plan: Record<string, unknown>;
  outputArtifactId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

function notebookGenerationPlans(
  notebook: NotebookDocument,
): NotebookGenerationPlanRecord[] {
  const value = notebook.properties?.generationPlans;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.planId !== "string"
      || typeof record.cellId !== "string"
      || typeof record.status !== "string"
      || !record.plan
      || typeof record.plan !== "object"
      || Array.isArray(record.plan)
      || typeof record.createdAt !== "string"
      || typeof record.updatedAt !== "string"
    ) {
      return [];
    }
    return [entry as NotebookGenerationPlanRecord];
  });
}

async function persistNotebookGenerationPlan(
  engine: Engine,
  notebookId: string,
  next: NotebookGenerationPlanRecord,
): Promise<void> {
  const result = await mutateNotebook(
    engine,
    notebookId,
    "persist_generation_plan",
    (notebook) => ({
      ...notebook,
      properties: {
        ...(notebook.properties ?? {}),
        generationPlans: [
          ...notebookGenerationPlans(notebook)
            .filter((candidate) => candidate.planId !== next.planId),
          next,
        ],
      },
    }),
    {
      planId: next.planId,
      cellId: next.cellId,
      status: next.status,
      outputArtifactId: next.outputArtifactId,
      error: next.error,
    },
  );
  if (!result.ok) throw new Error(result.error.message);
}

async function notebookGenerationPlan(
  engine: Engine,
  notebook: NotebookDocument,
  cellId: string,
  sourceSurface: "ui" | "slash" | "chat",
  actor: string,
  destination: {
    trackId?: string;
    timelineStartFrame: number;
    durationFrames?: number;
  },
): Promise<Record<string, unknown>> {
  const cell = notebook.cells.find((candidate) => candidate.id === cellId);
  if (!cell || (cell.type !== "image" && cell.type !== "video")) {
    throw new Error("Choose an image or video generation cell");
  }
  const prepared = await prepareNotebookGeneration(
    engine,
    notebook,
    cell,
    engine.book.get().bookId,
  );
  const costResult = await estimateCostDef(engine).handler({
    calls: [{
      tool_name: prepared.tool,
      input: prepared.input,
    }],
  });
  if (costResult.isError) {
    throw new Error(costResult.content[0]?.text ?? "Cost estimate failed");
  }
  const costText = costResult.content.find((item) => item.type === "text")?.text;
  const costValue = costText
    ? JSON.parse(costText) as {
        estimate?: { usd?: unknown; warnings?: unknown };
      }
    : {};
  const estimatedCost = typeof costValue.estimate?.usd === "number"
    ? costValue.estimate.usd
    : undefined;
  const warnings = Array.isArray(costValue.estimate?.warnings)
    ? costValue.estimate.warnings.filter(
        (warning): warning is string => typeof warning === "string",
      )
    : [];
  const estimateUnavailable = estimatedCost === undefined
    || warnings.some((warning) => warning.includes("no cost adapter registered"));
  const sequence = engine.sequences.getPrimary();
  const track = destination.trackId
    ? sequence.tracks.find((candidate) =>
        candidate.trackId === destination.trackId)
    : sequence.tracks.find((candidate) =>
        candidate.kind === "video" && candidate.enabled && !candidate.locked);
  if (!track || track.kind !== "video") {
    throw new Error("No editable video track is available for the generated output");
  }
  const plan = buildGenerationInsertPlan(engine, {
    tool: prepared.tool,
    input: {
      notebook_id: notebook.id,
      cell_id: cell.id,
      generation_tool: prepared.tool,
      generation_input: prepared.input,
    },
    provider: prepared.provider,
    model: prepared.model,
    ...(estimateUnavailable
      ? { estimate_unavailable: true }
      : { estimated_cost_usd: estimatedCost }),
    track_id: track.trackId,
    timeline_start_frame: destination.timelineStartFrame,
    ...(destination.durationFrames === undefined
      ? {}
      : { duration_frames: destination.durationFrames }),
  }, sourceSurface, actor);
  const stages = Array.isArray(plan.stages)
    ? plan.stages.map((stage) => {
        if (!stage || typeof stage !== "object" || Array.isArray(stage)) return stage;
        return {
          ...stage,
          tool: "run_notebook_cell",
        };
      })
    : [];
  const enriched = {
    ...plan,
    normalizedReferences: [
      ...(Array.isArray(plan.normalizedReferences)
        ? plan.normalizedReferences
        : []),
      {
        kind: "notebook",
        targetId: notebook.id,
        revision: engine.head,
      },
    ],
    stages,
  };
  const now = new Date().toISOString();
  await persistNotebookGenerationPlan(engine, notebook.id, {
    planId: String(enriched.planId),
    cellId: cell.id,
    status: "planned",
    plan: enriched,
    createdAt: now,
    updatedAt: now,
  });
  return enriched;
}

function sequenceRangeForSource(
  sequence: Sequence,
  artifactId: string,
  range: SourceRange,
): {
  sequenceId: string;
  sequenceRevision: string;
  clipId: string;
  trackId: string;
  range: {
    sequenceId: string;
    startFrame: number;
    durationFrames: number;
  };
} | null {
  const selectionEnd = sourceRangeEndTick(range);
  const clip = sequence.clips.find((candidate) => {
    if (candidate.source.kind !== "timed" || !("reverse" in candidate)) {
      return false;
    }
    return candidate.source.artifactId === artifactId
      && candidate.source.range.streamId === range.streamId
      && candidate.source.range.objectHash === range.objectHash
      && candidate.source.range.startTick <= range.startTick
      && sourceRangeEndTick(candidate.source.range) >= selectionEnd
      && !candidate.reverse
      && candidate.speed.numerator === candidate.speed.denominator;
  });
  if (!clip || clip.source.kind !== "timed" || !("reverse" in clip)) return null;
  const startFrame = clip.timelineStartFrame + sourceTicksToSequenceFrames(
    range.startTick - clip.source.range.startTick,
    range.timeBase,
    sequence.frameRate,
    "floor",
  );
  const durationFrames = Math.max(
    1,
    sourceTicksToSequenceFrames(
      range.durationTicks,
      range.timeBase,
      sequence.frameRate,
      "ceil",
    ),
  );
  return {
    sequenceId: sequence.sequenceId,
    sequenceRevision: sequence.revision,
    clipId: clip.clipId,
    trackId: clip.trackId,
    range: {
      sequenceId: sequence.sequenceId,
      startFrame,
      durationFrames,
    },
  };
}

function sourceRangeForSequence(
  sequence: Sequence,
  artifactId: string,
  startFrame: number,
  durationFrames: number,
): {
  clipId: string;
  trackId: string;
  sourceRange: SourceRange;
} | null {
  const endFrame = startFrame + durationFrames;
  const clip = sequence.clips.find((candidate) =>
    candidate.source.kind === "timed"
    && "reverse" in candidate
    && candidate.source.artifactId === artifactId
    && candidate.timelineStartFrame <= startFrame
    && candidate.timelineStartFrame + candidate.durationFrames >= endFrame
    && !candidate.reverse
    && candidate.speed.numerator === candidate.speed.denominator);
  if (!clip || clip.source.kind !== "timed" || !("reverse" in clip)) return null;
  const startOffset = sequenceFramesToSourceTicks(
    startFrame - clip.timelineStartFrame,
    sequence.frameRate,
    clip.source.range.timeBase,
    "floor",
  );
  const endOffset = sequenceFramesToSourceTicks(
    endFrame - clip.timelineStartFrame,
    sequence.frameRate,
    clip.source.range.timeBase,
    "ceil",
  );
  const clipSourceEnd = sourceRangeEndTick(clip.source.range);
  const sourceStart = Math.min(
    clipSourceEnd - 1,
    clip.source.range.startTick + startOffset,
  );
  const sourceEnd = Math.min(
    clipSourceEnd,
    clip.source.range.startTick + endOffset,
  );
  return {
    clipId: clip.clipId,
    trackId: clip.trackId,
    sourceRange: {
      ...clip.source.range,
      startTick: sourceStart,
      durationTicks: sourceEnd - sourceStart,
    },
  };
}

function captionOperationsForTranscript(
  sequence: Sequence,
  transcript: Transcript,
  captionTrack: CaptionTrack,
  styleId: string,
): EditOperation[] {
  const mappedWords = transcript.segments.flatMap((segment) =>
    segment.words.flatMap((word) => {
      const sourceRange: SourceRange = {
        streamId: segment.range.streamId,
        objectHash: segment.range.objectHash,
        startTick: word.startTick,
        durationTicks: word.durationTicks,
        timeBase: segment.range.timeBase,
      };
      const mapped = sequenceRangeForSource(
        sequence,
        transcript.artifactId,
        sourceRange,
      );
      return mapped
        ? [{ word, segment, sourceRange, mapped }]
        : [];
    })).sort((left, right) =>
      left.mapped.range.startFrame - right.mapped.range.startFrame);
  const groups: typeof mappedWords[] = [];
  for (const item of mappedWords) {
    const group = groups.at(-1);
    const first = group?.[0];
    const previous = group?.at(-1);
    const groupEnd = previous
      ? previous.mapped.range.startFrame + previous.mapped.range.durationFrames
      : 0;
    const prospectiveDuration = first
      ? item.mapped.range.startFrame + item.mapped.range.durationFrames
        - first.mapped.range.startFrame
      : 0;
    if (
      !group
      || !previous
      || item.mapped.clipId !== previous.mapped.clipId
      || item.mapped.range.startFrame > groupEnd + 3
      || group.length >= 7
      || prospectiveDuration > 90
    ) {
      groups.push([item]);
    } else {
      group.push(item);
    }
  }
  const sequenceEnd = Math.max(
    1,
    ...sequence.clips.map((clip) =>
      clip.timelineStartFrame + clip.durationFrames),
    ...sequence.captions.map((cue) =>
      cue.timelineStartFrame + cue.durationFrames),
  );
  return [{
    kind: "remove-range",
    trackIds: [captionTrack.trackId],
    range: {
      sequenceId: sequence.sequenceId,
      startFrame: 0,
      durationFrames: sequenceEnd,
    },
    ripple: false,
  }, ...groups.map((group) => {
    const first = group[0]!;
    const last = group.at(-1)!;
    const startFrame = first.mapped.range.startFrame;
    const endFrame = last.mapped.range.startFrame
      + last.mapped.range.durationFrames;
    const sourceEnd = sourceRangeEndTick(last.sourceRange);
    const speaker = group.every((item) =>
      item.segment.speaker === first.segment.speaker)
      ? first.segment.speaker
      : undefined;
    return {
      kind: "upsert-caption-cue" as const,
      cue: {
        cueId: uuidv5(
          `caption:${first.word.wordId}:${last.word.wordId}`,
          sequence.sequenceId,
        ),
        trackId: captionTrack.trackId,
        timelineStartFrame: startFrame,
        durationFrames: Math.max(1, endFrame - startFrame),
        text: group.map((item) => item.word.text)
          .join(" ")
          .replace(/\s+([,.;:!?])/gu, "$1"),
        ...(speaker ? { speaker } : {}),
        styleId,
        transcriptSelection: {
          transcriptId: transcript.transcriptId,
          transcriptRevision: transcript.revision,
          startWordId: first.word.wordId,
          endWordId: last.word.wordId,
          range: {
            ...first.sourceRange,
            durationTicks: Math.max(
              1,
              sourceEnd - first.sourceRange.startTick,
            ),
          },
        },
      },
    };
  })];
}

type CleanupSuggestion = {
  suggestionId: string;
  label: string;
  detail: string;
  category: "filler" | "silence" | "weak-section";
  included: boolean;
  operation: EditOperation;
};

function cleanupSuggestionsForTranscript(
  sequence: Sequence,
  transcript: Transcript,
): CleanupSuggestion[] {
  const trackIds = sequence.tracks
    .filter((track) => track.enabled && !track.locked)
    .map((track) => track.trackId);
  const candidates: Array<CleanupSuggestion & {
    startFrame: number;
    endFrame: number;
  }> = [];
  const addCandidate = (
    category: CleanupSuggestion["category"],
    label: string,
    detail: string,
    sourceRange: SourceRange,
    stableId: string,
  ) => {
    const mapped = sequenceRangeForSource(
      sequence,
      transcript.artifactId,
      sourceRange,
    );
    if (!mapped) return;
    const startFrame = mapped.range.startFrame;
    const endFrame = startFrame + mapped.range.durationFrames;
    candidates.push({
      suggestionId: `${category}:${stableId}`,
      label,
      detail,
      category,
      included: true,
      startFrame,
      endFrame,
      operation: {
        kind: "remove-range",
        trackIds,
        range: mapped.range,
        ripple: true,
      },
    });
  };
  const fillerPattern = /^(?:um+|uh+|erm+|hmm+|like)$/iu;
  for (const segment of transcript.segments) {
    if (segment.kind !== "speech") continue;
    for (const word of segment.words) {
      if (!fillerPattern.test(word.text.replace(/[.,!?]/gu, ""))) continue;
      addCandidate(
        "filler",
        `Remove “${word.text}”`,
        "Filler word",
        {
          streamId: segment.range.streamId,
          objectHash: segment.range.objectHash,
          startTick: word.startTick,
          durationTicks: word.durationTicks,
          timeBase: segment.range.timeBase,
        },
        word.wordId,
      );
    }
    const confidences = segment.words
      .map((word) => word.confidence)
      .filter((value): value is number => value !== undefined);
    const confidence = segment.confidence
      ?? (
        confidences.length > 0
          ? confidences.reduce((total, value) => total + value, 0) / confidences.length
          : undefined
      );
    if (confidence !== undefined && confidence < 0.6 && segment.words.length > 1) {
      addCandidate(
        "weak-section",
        `Review weak section: ${segment.text}`,
        `Low transcript confidence ${Math.round(confidence * 100)}%`,
        segment.range,
        segment.segmentId,
      );
    }
  }
  const speechWords = transcript.segments
    .filter((segment) => segment.kind === "speech")
    .flatMap((segment) => segment.words.map((word) => ({ segment, word })))
    .sort((left, right) => left.word.startTick - right.word.startTick);
  for (let index = 1; index < speechWords.length; index += 1) {
    const previous = speechWords[index - 1]!;
    const current = speechWords[index]!;
    if (
      previous.segment.range.streamId !== current.segment.range.streamId
      || previous.segment.range.objectHash !== current.segment.range.objectHash
    ) {
      continue;
    }
    const startTick = previous.word.startTick + previous.word.durationTicks;
    const durationTicks = current.word.startTick - startTick;
    const timeBase = current.segment.range.timeBase;
    const durationSeconds = durationTicks
      * timeBase.numerator
      / timeBase.denominator;
    if (durationSeconds < 0.75) continue;
    addCandidate(
      "silence",
      `Tighten ${durationSeconds.toFixed(1)}s silence`,
      `Pause between “${previous.word.text}” and “${current.word.text}”`,
      {
        streamId: current.segment.range.streamId,
        objectHash: current.segment.range.objectHash,
        startTick,
        durationTicks,
        timeBase,
      },
      `${previous.word.wordId}:${current.word.wordId}`,
    );
  }
  const accepted: CleanupSuggestion[] = [];
  const occupied: Array<{ startFrame: number; endFrame: number }> = [];
  const priority = { filler: 0, silence: 1, "weak-section": 2 };
  for (const candidate of candidates.sort((left, right) =>
    priority[left.category] - priority[right.category]
    || left.startFrame - right.startFrame)) {
    if (occupied.some((range) =>
      candidate.startFrame < range.endFrame
      && candidate.endFrame > range.startFrame)) {
      continue;
    }
    occupied.push({
      startFrame: candidate.startFrame,
      endFrame: candidate.endFrame,
    });
    const {
      startFrame: _startFrame,
      endFrame: _endFrame,
      ...suggestion
    } = candidate;
    accepted.push(suggestion);
  }
  return accepted.slice(0, 40);
}

function timedPlacementSlice(
  clip: TimedSequenceClip,
  sequence: Sequence,
  sliceStartFrame: number,
  sliceEndFrame: number,
  timelineStartFrame: number,
): ClipPlacement {
  const sourceStartOffset = sequenceFramesToSourceTicks(
    sliceStartFrame - clip.timelineStartFrame,
    sequence.frameRate,
    clip.source.range.timeBase,
    "floor",
  );
  const sourceEndOffset = sequenceFramesToSourceTicks(
    sliceEndFrame - clip.timelineStartFrame,
    sequence.frameRate,
    clip.source.range.timeBase,
    "ceil",
  );
  return {
    trackId: clip.trackId,
    timelineStartFrame,
    durationFrames: sliceEndFrame - sliceStartFrame,
    source: {
      kind: "timed",
      artifactId: clip.source.artifactId,
      range: {
        ...clip.source.range,
        startTick: clip.source.range.startTick + sourceStartOffset,
        durationTicks: sourceEndOffset - sourceStartOffset,
      },
    },
    speed: clip.speed,
    reverse: clip.reverse,
    audioPolicy: clip.audioPolicy,
    ...(clip.transform ? { transform: clip.transform } : {}),
    ...(clip.audio ? { audio: clip.audio } : {}),
  };
}

function reorderedAudioPlacements(
  sequence: Sequence,
  mapped: NonNullable<ReturnType<typeof sequenceRangeForSource>>,
  selectedSource: SourceRange,
  destinationFrame: number,
  artifactId: string,
): ClipPlacement[] | null {
  const trackClips = sequence.clips
    .filter((clip) => clip.trackId === mapped.trackId)
    .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame);
  if (trackClips.some((clip) =>
    clip.source.kind !== "timed"
    || !("reverse" in clip)
    || clip.reverse
    || clip.speed.numerator !== clip.speed.denominator)) {
    return null;
  }
  const removeStart = mapped.range.startFrame;
  const removeEnd = removeStart + mapped.range.durationFrames;
  const destinationAfterRemoval = destinationFrame > removeEnd
    ? destinationFrame - mapped.range.durationFrames
    : destinationFrame;
  const remaining: ClipPlacement[] = [];
  for (const candidate of trackClips) {
    if (candidate.source.kind !== "timed" || !("reverse" in candidate)) {
      return null;
    }
    const clip = candidate as TimedSequenceClip;
    const clipStart = clip.timelineStartFrame;
    const clipEnd = clipStart + clip.durationFrames;
    if (clipEnd <= removeStart || clipStart >= removeEnd) {
      remaining.push(timedPlacementSlice(
        clip,
        sequence,
        clipStart,
        clipEnd,
        clipStart >= removeEnd
          ? clipStart - mapped.range.durationFrames
          : clipStart,
      ));
      continue;
    }
    if (clipStart < removeStart) {
      remaining.push(timedPlacementSlice(
        clip,
        sequence,
        clipStart,
        removeStart,
        clipStart,
      ));
    }
    if (clipEnd > removeEnd) {
      remaining.push(timedPlacementSlice(
        clip,
        sequence,
        removeEnd,
        clipEnd,
        removeStart,
      ));
    }
  }
  const selectedPlacement: ClipPlacement = {
    trackId: mapped.trackId,
    timelineStartFrame: destinationAfterRemoval,
    durationFrames: mapped.range.durationFrames,
    source: {
      kind: "timed",
      artifactId,
      range: selectedSource,
    },
    speed: { numerator: 1, denominator: 1 },
    reverse: false,
    audioPolicy: "preserve-pitch",
  };
  const result: ClipPlacement[] = [];
  let inserted = false;
  for (const placement of remaining) {
    const start = placement.timelineStartFrame;
    const end = start + placement.durationFrames;
    if (!inserted && destinationAfterRemoval <= start) {
      result.push(selectedPlacement);
      inserted = true;
    }
    if (
      !inserted
      && destinationAfterRemoval > start
      && destinationAfterRemoval < end
      && placement.source.kind === "timed"
    ) {
      const clip = {
        ...placement,
        clipId: uuidv7(),
        enabled: true,
      } as TimedSequenceClip;
      result.push(timedPlacementSlice(
        clip,
        sequence,
        start,
        destinationAfterRemoval,
        start,
      ));
      result.push(selectedPlacement);
      result.push(timedPlacementSlice(
        clip,
        sequence,
        destinationAfterRemoval,
        end,
        destinationAfterRemoval + mapped.range.durationFrames,
      ));
      inserted = true;
      continue;
    }
    result.push({
      ...placement,
      timelineStartFrame: inserted
        ? placement.timelineStartFrame + mapped.range.durationFrames
        : placement.timelineStartFrame,
    });
  }
  if (!inserted) result.push(selectedPlacement);
  return result.sort(
    (left, right) => left.timelineStartFrame - right.timelineStartFrame,
  );
}

function cellFromInput(input: CellInput): Omit<NotebookCell, "id"> {
  return {
    type: input.type,
    title: input.title,
    position: input.position,
    ...(input.entity_id ? { entityId: input.entity_id } : {}),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    ...(input.tool === undefined ? {} : { tool: input.tool }),
    ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
    ...(input.output_artifact_id ? { outputArtifactId: input.output_artifact_id } : {}),
    ...(input.references === undefined
      ? {}
      : { references: input.references.map(referenceFromInput) }),
    ...(input.pinned_results === undefined
      ? {}
      : { pinnedResults: input.pinned_results.map(pinnedResultFromInput) }),
  };
}

function cellPayload(cell: NotebookCell): Record<string, unknown> {
  return {
    id: cell.id,
    type: cell.type,
    title: cell.title,
    position: cell.position,
    ...(cell.entityId ? { entity_id: cell.entityId } : {}),
    ...(cell.prompt === undefined ? {} : { prompt: cell.prompt }),
    ...(cell.provider === undefined ? {} : { provider: cell.provider }),
    ...(cell.model === undefined ? {} : { model: cell.model }),
    ...(cell.operation === undefined ? {} : { operation: cell.operation }),
    ...(cell.tool === undefined ? {} : { tool: cell.tool }),
    ...(cell.inputs === undefined ? {} : { inputs: cell.inputs }),
    ...(cell.outputArtifactId ? { output_artifact_id: cell.outputArtifactId } : {}),
    ...(cell.references === undefined
      ? {}
      : {
          references: cell.references.map((reference) => ({
            id: reference.id,
            kind: reference.kind,
            target_id: reference.targetId,
            snapshot: reference.snapshot,
            ordinal: reference.ordinal,
          })),
        }),
    ...(cell.pinnedResults === undefined
      ? {}
      : {
          pinned_results: cell.pinnedResults.map((result) => ({
            id: result.id,
            artifact_id: result.artifactId,
            object_hash: result.objectHash,
            location: result.location,
            ...(result.representativeTick === undefined
              ? {}
              : { representative_tick: result.representativeTick }),
            query: result.query,
            signals: result.signals,
            selected_revision: result.selectedRevision,
            ordinal: result.ordinal,
            created_at: result.createdAt,
          })),
        }),
  };
}

function notebookPayload(notebook: NotebookDocument): Record<string, unknown> {
  return {
    id: notebook.id,
    name: notebook.name,
    created_at: notebook.createdAt,
    properties: notebook.properties ?? {},
    cells: notebook.cells.map(cellPayload),
    edges: notebook.edges,
  };
}

function entityDefs(engine: Engine, type: EntityType): ToolDef[] {
  const plural = type === "character" ? "characters" : `${type}s`;
  return [
    {
      name: `create_${type}_entity`,
      description: `Create a reusable ${type}`,
      scope: "book",
      schema: {
        ...bookSchema,
        name: z.string().min(1),
        description: z.string().optional(),
        prompt: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      },
      handler: async (args) => {
        const result = await engine.entities.create(type, String(args.name), {
          ...(typeof args.description === "string" ? { description: args.description } : {}),
          ...(typeof args.prompt === "string" ? { prompt: args.prompt } : {}),
          data: args.data as Record<string, unknown> | undefined,
        });
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: `list_${plural}`,
      description: `List reusable ${plural}`,
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.entities.list(type)),
    },
    {
      name: `get_${type}_entity`,
      description: `Read a reusable ${type}`,
      scope: "book",
      schema: { ...bookSchema, entity_id: z.string().uuid() },
      handler: async (args) => {
        const result = engine.entities.read(String(args.entity_id));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: `update_${type}_entity`,
      description: `Update a reusable ${type}`,
      scope: "book",
      schema: { ...bookSchema, entity: z.record(z.string(), z.unknown()) },
      handler: async (args) => {
        const result = await engine.entities.write(args.entity as unknown as EntityDocument);
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: `delete_${type}_entity`,
      description: `Delete a reusable ${type}`,
      scope: "book",
      schema: { ...bookSchema, entity_id: z.string().uuid() },
      handler: async (args) => {
        const result = await engine.entities.delete(String(args.entity_id));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
  ];
}

export function videobookDomainDefs(
  engine: Engine,
  books: BookManager,
): ToolDef[] {
  return [
    {
      name: "list_books",
      description: "List all Videobook books",
      scope: "global",
      schema: { sort: z.enum(["newest", "oldest"]).optional() },
      handler: async (args) => {
        await books.ready();
        return json(books.list({
          ...(args.sort === "newest" || args.sort === "oldest" ? { sort: args.sort } : {}),
        }));
      },
    },
    {
      name: "create_book",
      description: "Create a book with a Main notebook",
      scope: "global",
      schema: { slug: z.string().min(1) },
      handler: async (args) => {
        const result = await books.create(String(args.slug));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "list_legacy_books",
      description: "List schema-v4 books awaiting an explicit copy-forward migration",
      scope: "global",
      schema: {},
      handler: async () => {
        await books.ready();
        return json(books.listLegacy());
      },
    },
    {
      name: "migrate_legacy_book",
      description: "Copy a confirmed schema-v4 book to v5 and archive the untouched source",
      scope: "global",
      schema: {
        book_id: z.string().uuid(),
        expected_source_head: z.string().min(1),
      },
      handler: async (args) => {
        const result = await books.migrateLegacy(
          String(args.book_id),
          String(args.expected_source_head),
        );
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "rename_book",
      description: "Rename a book",
      scope: "global",
      schema: { ...bookSchema, slug: z.string().min(1) },
      handler: async (args) => {
        const result = await books.rename(String(args.book_id), String(args.slug));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "delete_book",
      description: "Permanently delete a book after typed slug confirmation",
      scope: "global",
      schema: { ...bookSchema, confirm_slug: z.string().min(1) },
      handler: async (args) => {
        const result = await books.delete(String(args.book_id), {
          confirmSlug: String(args.confirm_slug),
          beforeDelete: async (book) => stopBookQueue(book.bookId),
        });
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "get_book",
      description: "Read the current book identity",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.book.get()),
    },
    {
      name: "check_duplicate_bytes",
      description: "Find existing book files with the same immutable content hash before import",
      scope: "book",
      schema: {
        ...bookSchema,
        object_hash: z.string().regex(/^[0-9a-f]{64}$/i),
      },
      handler: async (args) => {
        const objectHash = String(args.object_hash).toLowerCase();
        const matches = [];
        for (const artifact of engine.artifacts.list()) {
          const manifest = await engine.files.manifest(artifact.artifactId);
          if (!manifest.ok) continue;
          for (const file of manifest.value.files) {
            if (file.objectHash.toLowerCase() !== objectHash) continue;
            matches.push({
              artifact_id: artifact.artifactId,
              slug: artifact.slug,
              kind: artifact.kind,
              filename: file.name,
              object_hash: file.objectHash,
            });
          }
        }
        return json({ object_hash: objectHash, matches });
      },
    },
    {
      name: "list_notebooks",
      description: "List schema-v5 notebook documents",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.notebooks.list().map(notebookPayload)),
    },
    {
      name: "get_primary_sequence",
      description: "Read the canonical schema-v5 primary sequence",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.sequences.getPrimary()),
    },
    {
      name: "add_sequence_track",
      description: "Append a canonical video, audio, or caption track",
      scope: "book",
      schema: {
        ...bookSchema,
        kind: z.enum(["video", "audio", "caption"]),
        name: z.string().min(1).optional(),
      },
      handler: async (args) => {
        const sequence = engine.sequences.getPrimary();
        const result = await engine.sequences.addTrack(sequence.sequenceId, {
          kind: args.kind as "video" | "audio" | "caption",
          ...(typeof args.name === "string" ? { name: args.name } : {}),
        });
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "remove_sequence_track",
      description: "Remove an empty canonical track while preserving required track kinds",
      scope: "book",
      schema: {
        ...bookSchema,
        track_id: z.string().uuid(),
      },
      handler: async (args) => {
        const result = await engine.sequences.removeTrack(String(args.track_id));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "plan_notebook_generation",
      description: "Plan a notebook image or video generation with provider, model, cost, and revision-pinned insertion",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid(),
        source_surface: z.enum(["ui", "slash", "chat"]),
        actor: z.string().min(1),
        track_id: z.string().uuid().optional(),
        timeline_start_frame: z.number().int().nonnegative(),
        duration_frames: z.number().int().positive().optional(),
      },
      handler: async (args) => {
        try {
          const notebook = engine.notebooks.read(String(args.notebook_id));
          if (!notebook.ok) return failure(notebook.error.message);
          return json(await notebookGenerationPlan(
            engine,
            notebook.value,
            String(args.cell_id),
            args.source_surface as "ui" | "slash" | "chat",
            String(args.actor),
            {
              ...(typeof args.track_id === "string"
                ? { trackId: args.track_id }
                : {}),
              timelineStartFrame: Number(args.timeline_start_frame),
              ...(typeof args.duration_frames === "number"
                ? { durationFrames: args.duration_frames }
                : {}),
            },
          ));
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "list_notebook_generation_plans",
      description: "List durable generation plans and their retryable lifecycle state",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
      },
      handler: async (args) => {
        const notebook = engine.notebooks.read(String(args.notebook_id));
        return notebook.ok
          ? json(notebookGenerationPlans(notebook.value))
          : failure(notebook.error.message);
      },
    },
    {
      name: "revise_notebook_generation_plan",
      description: "Retry, switch the allowed generation model, or omit a preserved notebook generation plan",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        plan_id: z.string().uuid(),
        action: z.enum(["retry", "switch", "omit"]),
        model: z.string().min(1).optional(),
        source_surface: z.enum(["ui", "slash", "chat"]),
        actor: z.string().min(1),
      },
      handler: async (args) => {
        try {
          const notebookResult = engine.notebooks.read(String(args.notebook_id));
          if (!notebookResult.ok) return failure(notebookResult.error.message);
          let notebook = notebookResult.value;
          const existing = notebookGenerationPlans(notebook).find((candidate) =>
            candidate.planId === String(args.plan_id));
          if (!existing) return failure("Generation plan not found");
          if (args.action === "omit") {
            await persistNotebookGenerationPlan(engine, notebook.id, {
              ...existing,
              status: "omitted",
              updatedAt: new Date().toISOString(),
            });
            return json({
              kind: "generation-omitted",
              planId: existing.planId,
              outputArtifactId: existing.outputArtifactId,
            });
          }
          if (args.action === "switch") {
            if (typeof args.model !== "string") {
              return failure("Switching requires an allowed generation model");
            }
            const nextModel = String(args.model);
            const updated = await mutateNotebook(
              engine,
              notebook.id,
              "switch_generation_model",
              (document) => ({
                ...document,
                cells: document.cells.map((cell) =>
                  cell.id === existing.cellId
                    ? {
                        ...cell,
                        model: nextModel,
                        // Model switch can pass a generation tool name; keep tool in sync.
                        ...(nextModel.startsWith("generate_")
                          || nextModel.startsWith("extend_")
                          || nextModel.startsWith("upscale_")
                          ? { tool: nextModel }
                          : {}),
                      }
                    : cell),
              }),
              {
                sourcePlanId: existing.planId,
                cellId: existing.cellId,
                model: args.model,
              },
            );
            if (!updated.ok) return failure(updated.error.message);
            const refreshed = engine.notebooks.read(notebook.id);
            if (!refreshed.ok) return failure(refreshed.error.message);
            notebook = refreshed.value;
          }
          const stages = Array.isArray(existing.plan.stages)
            ? existing.plan.stages
            : [];
          const queued = stages.find((stage) =>
            stage
            && typeof stage === "object"
            && !Array.isArray(stage)
            && (stage as Record<string, unknown>).kind === "queued") as
            | Record<string, unknown>
            | undefined;
          const continuation = queued?.continuation
            && typeof queued.continuation === "object"
            && !Array.isArray(queued.continuation)
            ? queued.continuation as Record<string, unknown>
            : null;
          const destination = continuation?.destination
            && typeof continuation.destination === "object"
            && !Array.isArray(continuation.destination)
            ? continuation.destination as Record<string, unknown>
            : null;
          if (
            !destination
            || typeof destination.timelineStartFrame !== "number"
          ) {
            return failure("The preserved generation destination is invalid");
          }
          const next = await notebookGenerationPlan(
            engine,
            notebook,
            existing.cellId,
            args.source_surface as "ui" | "slash" | "chat",
            String(args.actor),
            {
              ...(typeof destination.trackId === "string"
                ? { trackId: destination.trackId }
                : {}),
              timelineStartFrame: destination.timelineStartFrame,
              ...(typeof destination.durationFrames === "number"
                ? { durationFrames: destination.durationFrames }
                : {}),
            },
          );
          return json({
            ...next,
            parentActionId: existing.planId,
          });
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "continue_notebook_generation",
      description: "Create a reviewable insertion plan for a completed generation or report a stale destination",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        plan_id: z.string().uuid(),
        actor: z.string().min(1),
      },
      handler: async (args) => {
        try {
          const notebook = engine.notebooks.read(String(args.notebook_id));
          if (!notebook.ok) return failure(notebook.error.message);
          const existing = notebookGenerationPlans(notebook.value).find(
            (candidate) => candidate.planId === String(args.plan_id),
          );
          if (!existing) return failure("Generation plan not found");
          if (!existing.outputArtifactId) {
            return failure("Generation output is not ready");
          }
          const continuation = await continueQueuedInsert(
            engine,
            existing.plan,
            existing.outputArtifactId,
            String(args.actor),
          );
          if (continuation.kind !== "stale-continuation") {
            await persistNotebookGenerationPlan(engine, notebook.value.id, {
              ...existing,
              status: "continued",
              updatedAt: new Date().toISOString(),
            });
          }
          return json(continuation);
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "plan_notebook_captions",
      description: "Create a reviewable caption replacement plan from the notebook audio transcript",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        source_surface: z.enum(["ui", "slash", "chat"]),
        actor: z.string().min(1),
        style_id: z.enum(["clean", "bold", "high-contrast"]),
      },
      handler: async (args) => {
        const notebook = engine.notebooks.read(String(args.notebook_id));
        if (!notebook.ok) return failure(notebook.error.message);
        const spine = notebook.value.properties?.audioSpine as
          | Record<string, unknown>
          | undefined;
        const artifactId = spine?.artifactId;
        if (typeof artifactId !== "string") {
          return failure("Choose an audio spine before generating captions");
        }
        const transcripts = engine.transcripts.list(artifactId);
        if (!transcripts.ok) return failure(transcripts.error.message);
        const transcript = transcripts.value.at(-1);
        if (!transcript) return failure("The audio spine has no timed transcript");
        const sequence = engine.sequences.getPrimary();
        const captionTrack = sequence.tracks.find((track) =>
          track.kind === "caption" && track.enabled && !track.locked);
        if (!captionTrack || captionTrack.kind !== "caption") {
          return failure("No editable caption track is available");
        }
        const operations = captionOperationsForTranscript(
          sequence,
          transcript,
          captionTrack,
          String(args.style_id),
        );
        if (operations.length < 2) {
          return failure("No transcript words are present on the current sequence");
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
          operations,
        };
        return json({
          planVersion: 1,
          planId,
          sourceSurface,
          actor,
          bookId: engine.book.get().bookId,
          summary: `Replace captions from ${transcript.language} transcript`,
          normalizedReferences: [{
            kind: "sequence",
            targetId: sequence.sequenceId,
            revision: engine.head,
          }, {
            kind: "notebook",
            targetId: notebook.value.id,
            revision: engine.head,
          }],
          stages: [{
            stageId: `${planId}:edit:0`,
            kind: "edit",
            summary: `Replace with ${operations.length - 1} caption cues`,
            intent,
          }],
          confirmation: {
            required: true,
            policy: "always",
            reason: "This plan replaces the current caption track",
          },
        });
      },
    },
    {
      name: "plan_notebook_cleanup",
      description: "Suggest non-destructive filler, long-silence, and weak-section removals as a selectable CommandPlan",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        source_surface: z.enum(["ui", "slash", "chat"]),
        actor: z.string().min(1),
      },
      handler: async (args) => {
        const notebook = engine.notebooks.read(String(args.notebook_id));
        if (!notebook.ok) return failure(notebook.error.message);
        const spine = notebook.value.properties?.audioSpine as
          | Record<string, unknown>
          | undefined;
        const artifactId = spine?.artifactId;
        if (typeof artifactId !== "string") {
          return failure("Choose an audio spine before suggesting cleanup");
        }
        const transcripts = engine.transcripts.list(artifactId);
        if (!transcripts.ok) return failure(transcripts.error.message);
        const transcript = transcripts.value.at(-1);
        if (!transcript) return failure("The audio spine has no timed transcript");
        const sequence = engine.sequences.getPrimary();
        const suggestions = cleanupSuggestionsForTranscript(sequence, transcript);
        if (suggestions.length === 0) {
          return json({
            kind: "no-cleanup-suggestions",
            categories: ["filler", "silence", "weak-section"],
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
          operations: suggestions.map((suggestion) => suggestion.operation),
        };
        return json({
          planVersion: 1,
          planId,
          sourceSurface,
          actor,
          bookId: engine.book.get().bookId,
          summary: `Review ${suggestions.length} narration cleanup suggestions`,
          normalizedReferences: [{
            kind: "sequence",
            targetId: sequence.sequenceId,
            revision: engine.head,
          }, {
            kind: "notebook",
            targetId: notebook.value.id,
            revision: engine.head,
          }],
          suggestions,
          stages: [{
            stageId: `${planId}:edit:0`,
            kind: "edit",
            summary: `Ripple-remove ${suggestions.length} selected ranges`,
            intent,
          }],
          confirmation: {
            required: true,
            policy: "always",
            reason: "Review each suggested removal before changing the sequence",
          },
        });
      },
    },
    {
      name: "create_notebook",
      description: "Create an empty notebook",
      scope: "book",
      schema: { ...bookSchema, name: z.string().min(1) },
      handler: async (args) => {
        const result = await engine.notebooks.create(String(args.name));
        return result.ok ? json(notebookPayload(result.value)) : failure(result.error.message);
      },
    },
    {
      name: "get_notebook",
      description: "Read a notebook graph",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid() },
      handler: async (args) => {
        const result = engine.notebooks.read(String(args.notebook_id));
        return result.ok ? json(notebookPayload(result.value)) : failure(result.error.message);
      },
    },
    {
      name: "list_notebook_actions",
      description: "List the deterministic notebook action catalog for runnable cells",
      scope: "book",
      schema: {
        ...bookSchema,
        cell_type: cellTypeSchema.optional(),
      },
      handler: async (args) => {
        const actions = listNotebookActions().filter((action) =>
          args.cell_type
            ? action.cellTypes.includes(args.cell_type as NotebookCellType)
            : true);
        return json({ actions });
      },
    },
    {
      name: "get_notebook_cell_details",
      description: "Return selected-cell details including raw Dolt row, edges, and action validation",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid(),
      },
      handler: async (args) => {
        const result = engine.notebooks.read(String(args.notebook_id));
        if (!result.ok) return failure(result.error.message);
        try {
          return json(selectedCellDetails(
            String(args.notebook_id),
            result.value,
            String(args.cell_id),
          ));
        } catch (cause) {
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
    {
      name: "ensure_notebook_workflow_scaffold",
      description: "Ensure the seven-stage SOURCE→EXPORT workflow scaffold exists",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        source_artifact_id: z.string().uuid().optional(),
      },
      handler: async (args) => {
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "ensure_notebook_workflow_scaffold",
          (notebook) => buildSevenStageScaffold(
            engine,
            notebook,
            typeof args.source_artifact_id === "string"
              ? args.source_artifact_id
              : undefined,
          ),
        );
        if (!result.ok) return failure(result.error.message);
        const read = engine.notebooks.read(String(args.notebook_id));
        return read.ok
          ? json(notebookPayload(read.value))
          : failure(read.error.message);
      },
    },
    {
      name: "rename_notebook",
      description: "Rename a notebook",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid(), name: z.string().min(1) },
      handler: async (args) => {
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "rename_notebook",
          (notebook) => ({ ...notebook, name: String(args.name) }),
        );
        return result.ok ? json({ notebook_id: args.notebook_id, revision: result.value.hash }) : failure(result.error.message);
      },
    },
    {
      name: "set_notebook_audio_spine",
      description: "Designate an audio or video artifact as the notebook's timed audio spine",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        artifact_id: z.string().uuid(),
      },
      handler: async (args) => {
        const artifact = engine.artifacts.get(String(args.artifact_id));
        if (!artifact.ok) return failure(artifact.error.message);
        if (
          artifact.value.kind !== "audio"
          && artifact.value.kind !== "video"
          && artifact.value.kind !== "final"
        ) {
          return failure("The notebook audio spine must be audio, video, or a rendered sequence mix");
        }
        const streams = engine.streams.list(artifact.value.artifactId);
        if (!streams.ok) return failure(streams.error.message);
        const stream = streams.value.find((candidate) => candidate.kind === "audio");
        if (!stream) return failure("The selected artifact has no registered audio stream");
        const transcripts = engine.transcripts.list(artifact.value.artifactId);
        const transcript = transcripts.ok ? transcripts.value.at(-1) : undefined;
        const sequence = engine.sequences.getPrimary();
        const audioTrack = sequence.tracks.find((candidate) =>
          candidate.kind === "audio" && candidate.enabled && !candidate.locked);
        if (!audioTrack) return failure("The primary sequence has no editable audio track");
        const durationFrames = Math.max(
          1,
          sourceTicksToSequenceFrames(
            stream.durationTicks,
            stream.timeBase,
            sequence.frameRate,
            "ceil",
          ),
        );
        const existingEnd = sequence.clips
          .filter((clip) => clip.trackId === audioTrack.trackId)
          .reduce(
            (end, clip) =>
              Math.max(end, clip.timelineStartFrame + clip.durationFrames),
            0,
          );
        const placement = {
          trackId: audioTrack.trackId,
          timelineStartFrame: 0,
          durationFrames,
          source: {
            kind: "timed" as const,
            artifactId: artifact.value.artifactId,
            range: {
              streamId: stream.streamId,
              objectHash: stream.objectHash,
              startTick: 0,
              durationTicks: stream.durationTicks,
              timeBase: stream.timeBase,
            },
          },
          speed: { numerator: 1, denominator: 1 },
          reverse: false,
          audioPolicy: "preserve-pitch" as const,
        };
        const intent: EditIntent = {
          intentVersion: MVP_CONTRACT_VERSION,
          commandId: uuidv7(),
          sequenceId: sequence.sequenceId,
          baseRevision: engine.head,
          actor: "videobook-ui",
          sourceSurface: "ui",
          confirmationPolicy: "reversible-single-step",
          operations: existingEnd > 0
            ? [{
                kind: "batch-replace-range",
                range: {
                  sequenceId: sequence.sequenceId,
                  startFrame: 0,
                  durationFrames: existingEnd,
                },
                trackIds: [audioTrack.trackId],
                placements: [placement],
                ripple: false,
              }]
            : [{
                kind: "insert-clip",
                mode: "insert",
                placement,
              }],
        };
        const preview = engine.edits.preview(intent);
        if (!preview.ok) return failure(preview.error.message);
        if (!preview.value.valid) return json({ preview: preview.value });
        const committed = await engine.edits.commit(intent, preview.value.previewHash);
        if (!committed.ok) return failure(committed.error.message);
        const spineClip = committed.value.sequence.clips.find((clip) =>
          clip.trackId === audioTrack.trackId
          && clip.timelineStartFrame === 0
          && clip.source.artifactId === artifact.value.artifactId);
        if (!spineClip) return failure("The audio spine sequence clip was not created");
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "set_notebook_audio_spine",
          (notebook) => {
            const removedIds = new Set(
              notebook.cells
                .filter((cell) =>
                  cell.inputs?.audioSpineRole === "audio"
                  || cell.inputs?.audioSpineRole === "transcript"
                  || cell.inputs?.audioSpineRole === "sequence")
                .map((cell) => cell.id),
            );
            const retained = notebook.cells.filter(
              (cell) => cell.inputs?.audioSpineRole !== "audio"
                && cell.inputs?.audioSpineRole !== "transcript"
                && cell.inputs?.audioSpineRole !== "sequence",
            );
            const audioCell = engine.notebooks.createCell({
              type: "audio",
              title: artifact.value.slug,
              position: { x: 0, y: 0 },
              inputs: {
                audioSpineRole: "audio",
                artifactId: artifact.value.artifactId,
                streamId: stream.streamId,
              },
            });
            const transcriptCell = engine.notebooks.createCell({
              type: "transcript",
              title: transcript ? `${artifact.value.slug} transcript` : "Transcript pending",
              position: { x: 360, y: 0 },
              inputs: {
                audioSpineRole: "transcript",
                artifactId: artifact.value.artifactId,
                ...(transcript ? { transcriptId: transcript.transcriptId } : {}),
              },
            });
            const edge = engine.notebooks.createEdge({
              source: audioCell.id,
              target: transcriptCell.id,
              targetInput: "audio",
            });
            const sequenceCell = engine.notebooks.createCell({
              type: "sequence",
              title: committed.value.sequence.name,
              position: { x: 720, y: 0 },
              inputs: {
                audioSpineRole: "sequence",
                sequenceId: committed.value.sequence.sequenceId,
                sequenceRevision: committed.value.revision,
                spineClipId: spineClip.clipId,
              },
              references: [{
                id: uuidv7(),
                kind: "sequence",
                targetId: committed.value.sequence.sequenceId,
                snapshot: {
                  revision: committed.value.revision,
                  clipId: spineClip.clipId,
                  artifactId: artifact.value.artifactId,
                },
                ordinal: 0,
              }],
            });
            const sequenceEdge = engine.notebooks.createEdge({
              source: transcriptCell.id,
              target: sequenceCell.id,
              targetInput: "transcript",
            });
            return {
              ...notebook,
              properties: {
                ...notebook.properties,
                audioSpine: {
                  artifactId: artifact.value.artifactId,
                  streamId: stream.streamId,
                  objectHash: stream.objectHash,
                  sourcePath: stream.sourcePath,
                  sequenceId: committed.value.sequence.sequenceId,
                  sequenceRevision: committed.value.revision,
                  trackId: audioTrack.trackId,
                  clipId: spineClip.clipId,
                },
              },
              cells: [...retained, audioCell, transcriptCell, sequenceCell],
              edges: [
                ...notebook.edges.filter((existing) =>
                  !removedIds.has(existing.source) && !removedIds.has(existing.target)),
                edge,
                sequenceEdge,
              ],
            };
          },
          {
            artifactId: artifact.value.artifactId,
            streamId: stream.streamId,
          },
        );
        return result.ok
          ? json({
              notebook_id: args.notebook_id,
              artifact_id: artifact.value.artifactId,
              stream_id: stream.streamId,
              sequence_id: committed.value.sequence.sequenceId,
              clip_id: spineClip.clipId,
              action_id: committed.value.actionId,
              revision: result.value.hash,
            })
          : failure(result.error.message);
      },
    },
    {
      name: "get_notebook_audio_spine",
      description: "Read the notebook audio spine, waveform, and current typed transcript",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid() },
      handler: async (args) => {
        const notebook = engine.notebooks.read(String(args.notebook_id));
        if (!notebook.ok) return failure(notebook.error.message);
        const spine = notebook.value.properties?.audioSpine;
        if (!spine || typeof spine !== "object" || Array.isArray(spine)) {
          return json({ spine: null, waveform: null, transcript: null });
        }
        const spineRecord = spine as Record<string, unknown>;
        const artifactId = typeof spineRecord.artifactId === "string"
          ? spineRecord.artifactId
          : null;
        if (!artifactId) return failure("The notebook audio spine is invalid");
        const artifact = engine.artifacts.get(artifactId);
        if (!artifact.ok) return failure(artifact.error.message);
        const waveform = await engine.metadata.waveforms.read(artifactId);
        const transcripts = engine.transcripts.list(artifactId);
        if (!transcripts.ok) return failure(transcripts.error.message);
        return json({
          spine: {
            artifact_id: artifact.value.artifactId,
            slug: artifact.value.slug,
            kind: artifact.value.kind,
            ...spineRecord,
          },
          waveform: waveform.ok ? waveform.value : null,
          transcript: transcripts.value.at(-1) ?? null,
        });
      },
    },
    {
      name: "correct_notebook_transcript_word",
      description: "Correct transcript text without changing the word's source timing",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        transcript_id: z.string().uuid(),
        word_id: z.string().uuid(),
        text: z.string().min(1),
      },
      handler: async (args) => {
        const notebook = engine.notebooks.read(String(args.notebook_id));
        if (!notebook.ok) return failure(notebook.error.message);
        const transcript = engine.transcripts.get(String(args.transcript_id));
        if (!transcript.ok) return failure(transcript.error.message);
        const spine = notebook.value.properties?.audioSpine as
          | Record<string, unknown>
          | undefined;
        if (spine?.artifactId !== transcript.value.artifactId) {
          return failure("The transcript does not belong to this notebook's audio spine");
        }
        const found = transcript.value.segments.some((segment) =>
          segment.words.some((word) => word.wordId === args.word_id));
        if (!found) return failure(`Transcript word not found: ${String(args.word_id)}`);
        const revised = await engine.transcripts.revise({
          sourceTranscriptId: transcript.value.transcriptId,
          language: transcript.value.language,
          provider: "human",
          model: transcript.value.model,
          segments: transcript.value.segments.map((segment) => {
            const words = segment.words.map((word) => {
              if (word.wordId !== args.word_id) return word;
              return {
                ...word,
                text: String(args.text),
                corrected: true,
              };
            });
            return {
              ordinal: segment.ordinal,
              range: segment.range,
              ...(segment.speaker ? { speaker: segment.speaker } : {}),
              text: segment.kind === "speech"
                ? words.map((word) => word.text).join(" ").replace(/\s+([,.;:!?])/g, "$1")
                : segment.text,
              ...(segment.confidence === undefined
                ? {}
                : { confidence: segment.confidence }),
              kind: segment.kind,
              words: words.map((word) => ({
                ordinal: word.ordinal,
                startTick: word.startTick,
                durationTicks: word.durationTicks,
                text: word.text,
                ...(word.confidence === undefined
                  ? {}
                  : { confidence: word.confidence }),
                corrected: word.corrected,
              })),
            };
          }),
        });
        if (!revised.ok) return failure(revised.error.message);
        const updated = await mutateNotebook(
          engine,
          notebook.value.id,
          "correct_notebook_transcript_word",
          (document) => ({
            ...document,
            cells: document.cells.map((cell) =>
              cell.inputs?.audioSpineRole === "transcript"
                ? {
                    ...cell,
                    title: `${revised.value.artifactId} transcript`,
                    inputs: {
                      ...cell.inputs,
                      transcriptId: revised.value.transcriptId,
                    },
                  }
                : cell),
          }),
          {
            transcriptId: revised.value.transcriptId,
            sourceTranscriptId: transcript.value.transcriptId,
            wordId: args.word_id,
          },
        );
        if (!updated.ok) return failure(updated.error.message);
        if (process.env.NODE_ENV !== "test") {
          await queue.enqueue(
            `semantic-index-${transcript.value.artifactId}-correction-${Date.now()}`,
            {
              type: "semantic_index",
              assetId: transcript.value.artifactId,
              bookId: engine.book.get().bookId,
            } as unknown as Record<string, unknown>,
          );
        }
        return json(revised.value);
      },
    },
    {
      name: "select_notebook_transcript_words",
      description: "Persist an exact timed transcript word range as a notebook selection",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        transcript_id: z.string().uuid(),
        start_word_id: z.string().uuid(),
        end_word_id: z.string().uuid(),
      },
      handler: async (args) => {
        const notebook = engine.notebooks.read(String(args.notebook_id));
        if (!notebook.ok) return failure(notebook.error.message);
        const transcript = engine.transcripts.get(String(args.transcript_id));
        if (!transcript.ok) return failure(transcript.error.message);
        const range = engine.transcripts.selectionRange(
          transcript.value.transcriptId,
          String(args.start_word_id),
          String(args.end_word_id),
        );
        if (!range.ok) return failure(range.error.message);
        const selection = {
          transcriptId: transcript.value.transcriptId,
          transcriptRevision: transcript.value.revision,
          startWordId: String(args.start_word_id),
          endWordId: String(args.end_word_id),
          range: range.value,
          sequence: sequenceRangeForSource(
            engine.sequences.getPrimary(),
            transcript.value.artifactId,
            range.value,
          ),
        };
        const result = await mutateNotebook(
          engine,
          notebook.value.id,
          "select_notebook_transcript_words",
          (document) => {
            const transcriptCell = document.cells.find(
              (cell) => cell.inputs?.audioSpineRole === "transcript",
            );
            const currentSelects = document.cells.find(
              (cell) => cell.inputs?.audioSpineRole === "selects",
            );
            const reference = {
              id: uuidv7(),
              kind: "source-range" as const,
              targetId: range.value.streamId,
              snapshot: {
                ...selection,
                artifactId: transcript.value.artifactId,
                objectHash: transcript.value.objectHash,
              },
              ordinal: currentSelects?.references?.length ?? 0,
            };
            const selectsCell = currentSelects
              ? {
                  ...currentSelects,
                  references: [...(currentSelects.references ?? []), reference],
                }
              : engine.notebooks.createCell({
                  type: "selects",
                  title: "Transcript selects",
                  position: { x: 1080, y: 0 },
                  inputs: {
                    audioSpineRole: "selects",
                    transcriptId: transcript.value.transcriptId,
                  },
                  references: [reference],
                });
            const cells = currentSelects
              ? document.cells.map((cell) =>
                  cell.id === currentSelects.id ? selectsCell : cell)
              : [...document.cells, selectsCell];
            const hasEdge = transcriptCell
              ? document.edges.some((edge) =>
                  edge.source === transcriptCell.id && edge.target === selectsCell.id)
              : true;
            const edges = transcriptCell && !hasEdge
              ? [
                  ...document.edges,
                  engine.notebooks.createEdge({
                    source: transcriptCell.id,
                    target: selectsCell.id,
                    targetInput: "transcript-range",
                  }),
                ]
              : document.edges;
            return {
              ...document,
              properties: {
                ...document.properties,
                currentSelection: selection,
              },
              cells,
              edges,
            };
          },
          selection,
        );
        return result.ok
          ? json({ ...selection, notebookRevision: result.value.hash })
          : failure(result.error.message);
      },
    },
    {
      name: "remove_notebook_transcript_words",
      description: "Preview and commit a source-immutable ripple removal of timed transcript words",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        transcript_id: z.string().uuid(),
        start_word_id: z.string().uuid(),
        end_word_id: z.string().uuid(),
        command_id: z.string().uuid().optional(),
        base_revision: z.string().min(1).optional(),
        preview_hash: z.string().min(1).optional(),
      },
      handler: async (args) => {
        const notebook = engine.notebooks.read(String(args.notebook_id));
        if (!notebook.ok) return failure(notebook.error.message);
        const transcript = engine.transcripts.get(String(args.transcript_id));
        if (!transcript.ok) return failure(transcript.error.message);
        const spine = notebook.value.properties?.audioSpine as
          | Record<string, unknown>
          | undefined;
        if (spine?.artifactId !== transcript.value.artifactId) {
          return failure("The transcript does not belong to this notebook's audio spine");
        }
        const selected = engine.transcripts.selectionRange(
          transcript.value.transcriptId,
          String(args.start_word_id),
          String(args.end_word_id),
        );
        if (!selected.ok) return failure(selected.error.message);
        const sequence = engine.sequences.getPrimary();
        const mapped = sequenceRangeForSource(
          sequence,
          transcript.value.artifactId,
          selected.value,
        );
        if (!mapped) {
          return failure("The selected words are not present on the current audio spine timeline");
        }
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
            kind: "remove-range",
            trackIds: [
              mapped.trackId,
              ...sequence.tracks
                .filter((track) => track.kind === "caption")
                .map((track) => track.trackId),
            ],
            range: mapped.range,
            ripple: true,
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
          return failure("The transcript edit preview changed; review the latest preview");
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
        if (!committed.ok) return failure(committed.error.message);
        const updated = await mutateNotebook(
          engine,
          notebook.value.id,
          "remove_notebook_transcript_words",
          (document) => {
            const edits = Array.isArray(document.properties?.transcriptEdits)
              ? document.properties.transcriptEdits
              : [];
            return {
              ...document,
              properties: {
                ...document.properties,
                currentSelection: {
                  transcriptId: transcript.value.transcriptId,
                  transcriptRevision: transcript.value.revision,
                  startWordId: String(args.start_word_id),
                  endWordId: String(args.end_word_id),
                  range: selected.value,
                  sequence: mapped,
                  removed: true,
                  actionId: committed.value.actionId,
                },
                transcriptEdits: [
                  ...edits,
                  {
                    kind: "remove",
                    actionId: committed.value.actionId,
                    commandId,
                    transcriptId: transcript.value.transcriptId,
                    startWordId: String(args.start_word_id),
                    endWordId: String(args.end_word_id),
                    sourceRange: selected.value,
                    sequenceRange: mapped.range,
                    baseRevision: intent.baseRevision,
                    revision: committed.value.revision,
                    restored: false,
                  },
                ],
              },
              cells: document.cells.map((cell) =>
                cell.inputs?.audioSpineRole === "sequence"
                  ? {
                      ...cell,
                      inputs: {
                        ...cell.inputs,
                        sequenceRevision: committed.value.revision,
                      },
                    }
                  : cell),
            };
          },
          {
            actionId: committed.value.actionId,
            transcriptId: transcript.value.transcriptId,
            startWordId: args.start_word_id,
            endWordId: args.end_word_id,
          },
        );
        if (!updated.ok) return failure(updated.error.message);
        return json({
          preview: preview.value,
          commit: committed.value,
          notebookRevision: updated.value.hash,
        });
      },
    },
    {
      name: "select_notebook_timeline_range",
      description: "Map a primary-sequence range back to timed transcript words and persist it",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        start_frame: z.number().int().nonnegative(),
        duration_frames: z.number().int().positive(),
      },
      handler: async (args) => {
        const notebook = engine.notebooks.read(String(args.notebook_id));
        if (!notebook.ok) return failure(notebook.error.message);
        const spine = notebook.value.properties?.audioSpine;
        if (!spine || typeof spine !== "object" || Array.isArray(spine)) {
          return failure("Set an audio spine before selecting the timeline");
        }
        const artifactId = (spine as Record<string, unknown>).artifactId;
        if (typeof artifactId !== "string") {
          return failure("The notebook audio spine is invalid");
        }
        const transcripts = engine.transcripts.list(artifactId);
        if (!transcripts.ok) return failure(transcripts.error.message);
        const transcript = transcripts.value.at(-1);
        if (!transcript) return failure("The audio spine has no timed transcript");
        const sequence = engine.sequences.getPrimary();
        const startFrame = Number(args.start_frame);
        const durationFrames = Number(args.duration_frames);
        const mapped = sourceRangeForSequence(
          sequence,
          artifactId,
          startFrame,
          durationFrames,
        );
        if (!mapped) {
          return failure("The timeline range is not contained by an audio spine clip");
        }
        const sourceEnd = sourceRangeEndTick(mapped.sourceRange);
        const words = transcript.segments.flatMap((segment) => segment.words);
        const selectedWords = words.filter((word) =>
          word.startTick < sourceEnd
          && word.startTick + word.durationTicks > mapped.sourceRange.startTick);
        const firstWord = selectedWords[0];
        const lastWord = selectedWords.at(-1);
        if (!firstWord || !lastWord) {
          return failure("The timeline range does not overlap timed transcript words");
        }
        const selection = {
          transcriptId: transcript.transcriptId,
          transcriptRevision: transcript.revision,
          startWordId: firstWord.wordId,
          endWordId: lastWord.wordId,
          range: mapped.sourceRange,
          sequence: {
            sequenceId: sequence.sequenceId,
            sequenceRevision: sequence.revision,
            clipId: mapped.clipId,
            trackId: mapped.trackId,
            range: {
              sequenceId: sequence.sequenceId,
              startFrame,
              durationFrames,
            },
          },
        };
        const result = await mutateNotebook(
          engine,
          notebook.value.id,
          "select_notebook_timeline_range",
          (document) => {
            const transcriptCell = document.cells.find(
              (cell) => cell.inputs?.audioSpineRole === "transcript",
            );
            const currentSelects = document.cells.find(
              (cell) => cell.inputs?.audioSpineRole === "selects",
            );
            const reference = {
              id: uuidv7(),
              kind: "source-range" as const,
              targetId: mapped.sourceRange.streamId,
              snapshot: {
                ...selection,
                artifactId,
                objectHash: mapped.sourceRange.objectHash,
              },
              ordinal: currentSelects?.references?.length ?? 0,
            };
            const selectsCell = currentSelects
              ? {
                  ...currentSelects,
                  references: [...(currentSelects.references ?? []), reference],
                }
              : engine.notebooks.createCell({
                  type: "selects",
                  title: "Timeline selects",
                  position: { x: 1080, y: 0 },
                  inputs: {
                    audioSpineRole: "selects",
                    transcriptId: transcript.transcriptId,
                  },
                  references: [reference],
                });
            const cells = currentSelects
              ? document.cells.map((cell) =>
                  cell.id === currentSelects.id ? selectsCell : cell)
              : [...document.cells, selectsCell];
            const hasEdge = transcriptCell
              ? document.edges.some((edge) =>
                  edge.source === transcriptCell.id && edge.target === selectsCell.id)
              : true;
            return {
              ...document,
              properties: {
                ...document.properties,
                currentSelection: selection,
              },
              cells,
              edges: transcriptCell && !hasEdge
                ? [
                    ...document.edges,
                    engine.notebooks.createEdge({
                      source: transcriptCell.id,
                      target: selectsCell.id,
                      targetInput: "timeline-range",
                    }),
                  ]
                : document.edges,
            };
          },
          selection,
        );
        return result.ok
          ? json({ ...selection, notebookRevision: result.value.hash })
          : failure(result.error.message);
      },
    },
    {
      name: "restore_notebook_transcript_edit",
      description: "Restore the sequence revision preceding a confirmed transcript edit",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        action_id: z.string().uuid(),
        confirm: z.boolean().optional().default(false),
      },
      handler: async (args) => {
        const notebook = engine.notebooks.read(String(args.notebook_id));
        if (!notebook.ok) return failure(notebook.error.message);
        const audit = engine.edits.get(String(args.action_id));
        if (!audit.ok) return failure(audit.error.message);
        const edits = Array.isArray(notebook.value.properties?.transcriptEdits)
          ? notebook.value.properties.transcriptEdits
          : [];
        const edit = edits.find((candidate) =>
          candidate
          && typeof candidate === "object"
          && !Array.isArray(candidate)
          && (candidate as Record<string, unknown>).actionId === args.action_id);
        if (!edit) {
          return failure("The edit action is not linked to this notebook");
        }
        if (args.confirm !== true) {
          return json({
            confirmationRequired: true,
            actionId: args.action_id,
            targetRevision: audit.value.baseRevision,
            currentRevision: engine.head,
            warning: "Restore creates a forward revision from the sequence state before this edit",
          });
        }
        const restored = await engine.edits.restore({
          targetRevision: audit.value.baseRevision,
          actor: "videobook-ui",
          sourceSurface: "ui",
          baseRevision: engine.head,
        });
        if (!restored.ok) return failure(restored.error.message);
        const updated = await mutateNotebook(
          engine,
          notebook.value.id,
          "restore_notebook_transcript_edit",
          (document) => ({
            ...document,
            properties: {
              ...document.properties,
              transcriptEdits: (Array.isArray(document.properties?.transcriptEdits)
                ? document.properties.transcriptEdits
                : []).map((candidate) => {
                if (
                  !candidate
                  || typeof candidate !== "object"
                  || Array.isArray(candidate)
                  || (candidate as Record<string, unknown>).actionId !== args.action_id
                ) {
                  return candidate;
                }
                return {
                  ...(candidate as Record<string, unknown>),
                  restored: true,
                  restoreActionId: restored.value.actionId,
                  restoreRevision: restored.value.revision,
                };
              }),
            },
            cells: document.cells.map((cell) =>
              cell.inputs?.audioSpineRole === "sequence"
                ? {
                    ...cell,
                    inputs: {
                      ...cell.inputs,
                      sequenceRevision: restored.value.revision,
                    },
                  }
                : cell),
          }),
          {
            actionId: args.action_id,
            restoreActionId: restored.value.actionId,
          },
        );
        if (!updated.ok) return failure(updated.error.message);
        return json({
          restore: restored.value,
          notebookRevision: updated.value.hash,
        });
      },
    },
    {
      name: "move_notebook_transcript_words",
      description: "Preview and commit reordering timed transcript words on the audio spine",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        transcript_id: z.string().uuid(),
        start_word_id: z.string().uuid(),
        end_word_id: z.string().uuid(),
        before_word_id: z.string().uuid(),
        command_id: z.string().uuid().optional(),
        base_revision: z.string().min(1).optional(),
        preview_hash: z.string().min(1).optional(),
      },
      handler: async (args) => {
        const notebook = engine.notebooks.read(String(args.notebook_id));
        if (!notebook.ok) return failure(notebook.error.message);
        const transcript = engine.transcripts.get(String(args.transcript_id));
        if (!transcript.ok) return failure(transcript.error.message);
        const spine = notebook.value.properties?.audioSpine as
          | Record<string, unknown>
          | undefined;
        if (spine?.artifactId !== transcript.value.artifactId) {
          return failure("The transcript does not belong to this notebook's audio spine");
        }
        const selected = engine.transcripts.selectionRange(
          transcript.value.transcriptId,
          String(args.start_word_id),
          String(args.end_word_id),
        );
        if (!selected.ok) return failure(selected.error.message);
        const destination = engine.transcripts.selectionRange(
          transcript.value.transcriptId,
          String(args.before_word_id),
          String(args.before_word_id),
        );
        if (!destination.ok) return failure(destination.error.message);
        const selectedEnd = sourceRangeEndTick(selected.value);
        if (
          destination.value.startTick >= selected.value.startTick
          && destination.value.startTick < selectedEnd
        ) {
          return failure("The destination word cannot be inside the moved range");
        }
        const sequence = engine.sequences.getPrimary();
        const mapped = sequenceRangeForSource(
          sequence,
          transcript.value.artifactId,
          selected.value,
        );
        const destinationMapped = sequenceRangeForSource(
          sequence,
          transcript.value.artifactId,
          destination.value,
        );
        if (!mapped || !destinationMapped || mapped.trackId !== destinationMapped.trackId) {
          return failure("The selected words and destination are not on the same audio spine timeline");
        }
        const placements = reorderedAudioPlacements(
          sequence,
          mapped,
          selected.value,
          destinationMapped.range.startFrame,
          transcript.value.artifactId,
        );
        if (!placements) {
          return failure("Transcript reordering requires forward, normal-speed audio spine clips");
        }
        const currentEnd = sequence.clips
          .filter((clip) => clip.trackId === mapped.trackId)
          .reduce(
            (end, clip) =>
              Math.max(end, clip.timelineStartFrame + clip.durationFrames),
            0,
          );
        if (currentEnd < 1) return failure("The audio spine timeline is empty");
        const movedPlacement = placements.find((placement) =>
          placement.source.kind === "timed"
          && placement.source.range.streamId === selected.value.streamId
          && placement.source.range.startTick === selected.value.startTick
          && placement.source.range.durationTicks === selected.value.durationTicks);
        if (!movedPlacement) return failure("The moved transcript placement could not be resolved");
        const words = transcript.value.segments
          .flatMap((segment) => segment.words);
        const startIndex = words.findIndex((word) => word.wordId === args.start_word_id);
        const endIndex = words.findIndex((word) => word.wordId === args.end_word_id);
        const lowIndex = Math.min(startIndex, endIndex);
        const highIndex = Math.max(startIndex, endIndex);
        const movedText = words
          .slice(lowIndex, highIndex + 1)
          .map((word) => word.text)
          .join(" ")
          .replace(/\s+([,.;:!?])/g, "$1");
        const captionTrack = sequence.tracks.find((track) =>
          track.kind === "caption" && track.enabled && !track.locked);
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
              startFrame: 0,
              durationFrames: currentEnd,
            },
            trackIds: [mapped.trackId],
            placements,
            ripple: false,
          }, ...(captionTrack && movedText
            ? [{
                kind: "upsert-caption-cue" as const,
                cue: {
                  cueId: uuidv5("transcript-move-caption", commandId),
                  trackId: captionTrack.trackId,
                  timelineStartFrame: movedPlacement.timelineStartFrame,
                  durationFrames: movedPlacement.durationFrames,
                  text: movedText,
                  styleId: "clean",
                  transcriptSelection: {
                    transcriptId: transcript.value.transcriptId,
                    transcriptRevision: transcript.value.revision,
                    startWordId: String(args.start_word_id),
                    endWordId: String(args.end_word_id),
                    range: selected.value,
                  },
                },
              }]
            : [])],
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
          return failure("The transcript reorder preview changed; review the latest preview");
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
        if (!committed.ok) return failure(committed.error.message);
        const updated = await mutateNotebook(
          engine,
          notebook.value.id,
          "move_notebook_transcript_words",
          (document) => {
            const edits = Array.isArray(document.properties?.transcriptEdits)
              ? document.properties.transcriptEdits
              : [];
            return {
              ...document,
              properties: {
                ...document.properties,
                transcriptEdits: [
                  ...edits,
                  {
                    kind: "move",
                    actionId: committed.value.actionId,
                    commandId,
                    transcriptId: transcript.value.transcriptId,
                    startWordId: String(args.start_word_id),
                    endWordId: String(args.end_word_id),
                    beforeWordId: String(args.before_word_id),
                    sourceRange: selected.value,
                    destinationSourceRange: destination.value,
                    sequenceRange: {
                      sequenceId: sequence.sequenceId,
                      startFrame: movedPlacement.timelineStartFrame,
                      durationFrames: movedPlacement.durationFrames,
                    },
                    baseRevision: intent.baseRevision,
                    revision: committed.value.revision,
                    restored: false,
                  },
                ],
              },
              cells: document.cells.map((cell) =>
                cell.inputs?.audioSpineRole === "sequence"
                  ? {
                      ...cell,
                      inputs: {
                        ...cell.inputs,
                        sequenceRevision: committed.value.revision,
                      },
                    }
                  : cell),
            };
          },
          {
            actionId: committed.value.actionId,
            transcriptId: transcript.value.transcriptId,
            startWordId: args.start_word_id,
            endWordId: args.end_word_id,
            beforeWordId: args.before_word_id,
          },
        );
        if (!updated.ok) return failure(updated.error.message);
        return json({
          preview: preview.value,
          commit: committed.value,
          notebookRevision: updated.value.hash,
        });
      },
    },
    {
      name: "delete_notebook",
      description: "Delete a notebook and its cells, edges, and runs",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid() },
      handler: async (args) => {
        const result = await engine.notebooks.delete(String(args.notebook_id));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "create_notebook_cell",
      description: "Create a UUIDv7 notebook cell",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid(), cell: cellInputSchema },
      handler: async (args) => {
        const cell = engine.notebooks.createCell(cellFromInput(args.cell as CellInput));
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "create_notebook_cell",
          (notebook) => ({ ...notebook, cells: [...notebook.cells, cell] }),
          { cellId: cell.id },
        );
        return result.ok ? json(cellPayload(cell)) : failure(result.error.message);
      },
    },
    {
      name: "update_notebook_cell",
      description: "Update one notebook cell",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid(),
        cell: cellInputSchema.partial(),
        expected_revision: z.string().min(1).optional(),
      },
      handler: async (args) => {
        if (
          typeof args.expected_revision === "string"
          && args.expected_revision !== engine.head
        ) {
          return failure(`Stale notebook revision: expected ${args.expected_revision}`);
        }
        const patch = args.cell as Partial<CellInput>;
        try {
          const result = await mutateNotebook(
            engine,
            String(args.notebook_id),
            "update_notebook_cell",
            (notebook) => {
              let found = false;
              const cells = notebook.cells.map((cell) => {
                if (cell.id !== args.cell_id) return cell;
                found = true;
                const next = normalizeCellActionFields({
                  ...cell,
                  ...(patch.type ? { type: patch.type as NotebookCellType } : {}),
                  ...(patch.title === undefined ? {} : { title: patch.title }),
                  ...(patch.position === undefined ? {} : { position: patch.position }),
                  ...(patch.entity_id === undefined ? {} : { entityId: patch.entity_id }),
                  ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
                  ...(patch.provider === undefined ? {} : { provider: patch.provider }),
                  ...(patch.model === undefined ? {} : { model: patch.model }),
                  ...(patch.operation === undefined ? {} : { operation: patch.operation }),
                  ...(patch.tool === undefined ? {} : { tool: patch.tool }),
                  ...(patch.inputs === undefined ? {} : { inputs: patch.inputs }),
                  ...(patch.output_artifact_id === undefined ? {} : { outputArtifactId: patch.output_artifact_id }),
                  ...(patch.references === undefined
                    ? {}
                    : { references: patch.references.map(referenceFromInput) }),
                  ...(patch.pinned_results === undefined
                    ? {}
                    : { pinnedResults: patch.pinned_results.map(pinnedResultFromInput) }),
                }, notebook);
                const validation = validateCellConfiguration(next, notebook);
                if (!validation.ok) throw new Error(validation.message);
                return next;
              });
              if (!found) throw new Error(`Cell not found: ${String(args.cell_id)}`);
              return markDescendantsStale({ ...notebook, cells }, String(args.cell_id));
            },
            { cellId: args.cell_id },
          );
          return result.ok
            ? json({ cell_id: args.cell_id, revision: result.value.hash })
            : failure(result.error.message);
        } catch (cause) {
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
    {
      name: "move_notebook_cells",
      description: "Persist notebook cell positions",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        positions: z.array(z.object({ id: z.string().uuid(), x: z.number(), y: z.number() })).min(1),
      },
      handler: async (args) => {
        const positions = new Map((args.positions as Array<{ id: string; x: number; y: number }>).map((position) => [position.id, position]));
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "move_notebook_cells",
          (notebook) => ({
            ...notebook,
            cells: notebook.cells.map((cell) => {
              const position = positions.get(cell.id);
              return position ? { ...cell, position: { x: position.x, y: position.y } } : cell;
            }),
          }),
          { cellIds: [...positions.keys()] },
        );
        return result.ok ? json({ notebook_id: args.notebook_id, revision: result.value.hash }) : failure(result.error.message);
      },
    },
    {
      name: "delete_notebook_cell",
      description: "Delete one notebook cell and incident edges",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid(), cell_id: z.string().uuid() },
      handler: async (args) => {
        const cellId = String(args.cell_id);
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "delete_notebook_cell",
          (notebook) => ({
            ...notebook,
            cells: notebook.cells.filter((cell) => cell.id !== cellId),
            edges: notebook.edges.filter((edge) => edge.source !== cellId && edge.target !== cellId),
          }),
          { cellId },
        );
        return result.ok ? json({ cell_id: cellId, revision: result.value.hash }) : failure(result.error.message);
      },
    },
    {
      name: "connect_notebook_cells",
      description: "Create a UUIDv7 notebook edge",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        source_cell_id: z.string().uuid(),
        target_cell_id: z.string().uuid(),
        target_input: z.string().min(1),
      },
      handler: async (args) => {
        const edge = engine.notebooks.createEdge({
          source: String(args.source_cell_id),
          target: String(args.target_cell_id),
          targetInput: String(args.target_input),
        });
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "connect_notebook_cells",
          (notebook) => ({ ...notebook, edges: [...notebook.edges, edge] }),
          { sourceCellId: edge.source, targetCellId: edge.target, edgeId: edge.id },
        );
        return result.ok ? json(edge) : failure(result.error.message);
      },
    },
    {
      name: "disconnect_notebook_cells",
      description: "Delete a notebook edge",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid(), edge_id: z.string().uuid() },
      handler: async (args) => {
        const edgeId = String(args.edge_id);
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "disconnect_notebook_cells",
          (notebook) => ({ ...notebook, edges: notebook.edges.filter((edge) => edge.id !== edgeId) }),
          { edgeId },
        );
        return result.ok ? json({ edge_id: edgeId, revision: result.value.hash }) : failure(result.error.message);
      },
    },
    {
      name: "run_notebook_cell",
      description: "Run a selected image or video notebook cell",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid(),
        plan: z.record(z.string(), z.unknown()).optional(),
        actor: z.string().min(1).optional(),
      },
      handler: async (args) => {
        const jobId = `run-notebook-${String(args.notebook_id)}-${String(args.cell_id)}-${Date.now()}`;
        const generationPlan = args.plan as Record<string, unknown> | undefined;
        if (generationPlan) {
          const notebook = engine.notebooks.read(String(args.notebook_id));
          if (!notebook.ok) return failure(notebook.error.message);
          const record = notebookGenerationPlans(notebook.value).find((candidate) =>
            candidate.planId === generationPlan.planId);
          if (!record) return failure("Generation plan is not preserved in this notebook");
          await persistNotebookGenerationPlan(engine, notebook.value.id, {
            ...record,
            status: "queued",
            updatedAt: new Date().toISOString(),
          });
        }
        await queue.enqueue(jobId, {
          type: "run_notebook",
          bookId: String(args.book_id),
          notebookId: String(args.notebook_id),
          cellIds: [String(args.cell_id)],
          force: true,
          ...(generationPlan
            ? {
                generationPlan,
                actor: typeof args.actor === "string" ? args.actor : "videobook-user",
                jobId,
              }
            : {}),
        });
        return json({
          job_id: jobId,
          ...(generationPlan ? { plan_id: generationPlan.planId } : {}),
        });
      },
    },
    {
      name: "run_notebook",
      description: "Run missing or stale image and video cells topologically",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid() },
      handler: async (args) => {
        const jobId = `run-notebook-${String(args.notebook_id)}-${Date.now()}`;
        await queue.enqueue(jobId, {
          type: "run_notebook",
          bookId: String(args.book_id),
          notebookId: String(args.notebook_id),
          force: false,
        });
        return json({ job_id: jobId });
      },
    },
    {
      name: "list_jobs",
      description: "List persistent jobs for a book",
      scope: "book",
      schema: {
        ...bookSchema,
        limit: z.number().int().positive().max(500).optional(),
      },
      handler: async (args) => json(engine.jobs.queue.list({
        limit: Number(args.limit) || 200,
      })),
    },
    {
      name: "cancel_job",
      description: "Cancel a queued or running persistent job",
      scope: "book",
      schema: {
        ...bookSchema,
        job_id: z.number().int().positive(),
        reason: z.string().min(1).max(500).optional(),
      },
      handler: async (args) => {
        const jobId = Number(args.job_id);
        const job = engine.jobs.queue.get(jobId);
        if (!job) return failure(`Job ${jobId} was not found`);
        const cancelled = await engine.jobs.queue.abort(
          jobId,
          typeof args.reason === "string" ? args.reason : "Cancelled by user",
        );
        if (!cancelled) {
          return failure(`Job ${jobId} is already ${job.state}`);
        }
        return json(engine.jobs.queue.get(jobId));
      },
    },
    {
      name: "retry_job",
      description: "Re-enqueue a failed or cancelled persistent job with the same durable payload",
      scope: "book",
      schema: {
        ...bookSchema,
        job_id: z.number().int().positive(),
      },
      handler: async (args) => {
        const jobId = Number(args.job_id);
        const job = engine.jobs.queue.get(jobId);
        if (!job) return failure(`Job ${jobId} was not found`);
        if (job.state !== "failed" && job.state !== "aborted") {
          return failure(`Job ${jobId} is ${job.state}, not retryable`);
        }
        const retryId = `retry-${job.type}-${uuidv7()}`;
        await queue.enqueue(retryId, {
          ...job.payload,
          type: job.type,
          bookId: engine.book.get().bookId,
        });
        return json({ status: "enqueued", retry_job_id: retryId, source_job_id: jobId });
      },
    },
    {
      name: "list_book_actions",
      description: "List permanent action history for a book",
      scope: "book",
      schema: { ...bookSchema, limit: z.number().int().positive().max(10_000).optional(), cursor: z.string().optional() },
      handler: async (args) => {
        const result = engine.history.actions({
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
        });
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "get_history_action",
      description: "Read one action history record",
      scope: "book",
      schema: { ...bookSchema, action_id: z.string().uuid() },
      handler: async (args) => {
        const result = engine.history.action(String(args.action_id));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "storage_status",
      description: "Read schema-v5 catalog and object publication status",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.storage.status()),
    },
    {
      name: "storage_sync",
      description: "Publish a book's pending content-addressed objects and catalog",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(await engine.storage.backup()),
    },
    ...entityDefs(engine, "prompt"),
    ...entityDefs(engine, "scene"),
    ...entityDefs(engine, "character"),
  ];
}
