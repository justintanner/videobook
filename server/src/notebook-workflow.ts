import type {
  Engine,
  NotebookCell,
  NotebookDocument,
  NotebookEdge,
  NotebookGridSlot,
} from "videobook-engine";
import {
  firstEmptyNotebookGridSlots,
  nextHorizontalSlotFrom,
  nextVerticalSlotFrom,
} from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import {
  isVerticalGenerationType,
  lastCreatedCellSlot,
} from "./notebook-placement.js";
import {
  DEFAULT_ANIMATION_TOOL,
  normalizeCellActionFields,
  normalizeLegacyAnalyzeCell,
} from "./notebook-action-catalog.js";
import { EXTRACT_AUDIO_OUTPUT_ROLE } from "./notebook-cell-outputs.js";
import {
  INTELLIGENCE_MODEL,
  OPENAI_ANALYSIS_TOOL,
} from "./openai-intelligence.js";
import type {
  AnalysisBoundary,
  NotebookAnalysisEvidence,
  NotebookAnalysisLlmExchange,
} from "./notebook-live-analysis.js";
import {
  normalizeShots,
  parseAnalysisShots,
  reconcileOwnedBranches,
  type NormalizedShot,
  type OwnedBranch,
} from "./notebook-shots.js";

export const DEFAULT_ANALYSIS_PROMPT =
  "Detect shot boundaries from verified camera switches and audio continuity; cover the source exactly and label each shot from evidence.";

const LEGACY_ANALYSIS_PROMPTS = new Set([
  "Segment the source into four continuous 15-second narrative shots with precise timestamps and concise visual context.",
  "Segment the source into two continuous 15-second narrative shots with precise timestamps and concise visual context.",
]);

function retainedAnalysisPrompt(existing: NotebookCell | undefined): string {
  const prompt = existing?.prompt?.trim();
  return !prompt || LEGACY_ANALYSIS_PROMPTS.has(prompt)
    ? DEFAULT_ANALYSIS_PROMPT
    : prompt;
}

export const MULTYCULTY_FEATURES = [
  {
    ordinal: 1,
    id: "import-analyze",
    label: "Import + Analyze",
    feature: "Source import and automatic shot analysis",
    caption: "FEATURE 01 · IMPORT + ANALYZE",
    promptBrief:
      "Preserve the seated subject and original composition while a refined filmstrip, waveform, and precise scene markers materialize around the source. Show the app turning one imported video into an understood edit without adding text.",
    column: 1,
  },
  {
    ordinal: 2,
    id: "split-extract",
    label: "Split + Extract",
    feature: "Scene splitting and reusable media extraction",
    caption: "FEATURE 02 · SPLIT + EXTRACT",
    promptBrief:
      "Preserve the people, car, and location while the moment separates into elegant first-frame, last-frame, and audio-wave components connected by clean editorial motion. Show reusable scene assets without adding text.",
    column: 2,
  },
  {
    ordinal: 3,
    id: "prompt-animate",
    label: "Prompt + Animate",
    feature: "Asset-grounded prompt writing and animation",
    caption: "FEATURE 03 · PROMPT + ANIMATE",
    promptBrief:
      "Preserve the character performance and identity while an abstract prompt ribbon becomes controlled motion paths that travel from the first frame to the last frame. Show grounded animation direction without adding text.",
    column: 4,
  },
  {
    ordinal: 4,
    id: "assemble-export",
    label: "Concatenate",
    feature: "Synchronized playable video concatenation",
    caption: "FEATURE 04 · CONCATENATE",
    promptBrief:
      "Preserve the dialogue scene and natural performance while four luminous editorial lanes converge into one synchronized landscape timeline and a polished finished master. Show completion and continuity without adding text.",
    column: 5,
  },
] as const;

type Feature = (typeof MULTYCULTY_FEATURES)[number];

interface BranchCells {
  splitVideo: NotebookCell;
  video: NotebookCell;
  first: NotebookCell;
  last: NotebookCell;
  extractAudio: NotebookCell;
  prompt: NotebookCell;
  animate: NotebookCell;
}

type BranchChildKind =
  | "video"
  | "first"
  | "last"
  | "extract-audio"
  | "prompt"
  | "animate";

interface ExistingBranchCells {
  video?: NotebookCell;
  first?: NotebookCell;
  last?: NotebookCell;
  extractAudio?: NotebookCell;
  prompt?: NotebookCell;
  animate?: NotebookCell;
}

function roleOf(cell: NotebookCell): string | null {
  return typeof cell.inputs?.workflowRole === "string"
    ? cell.inputs.workflowRole
    : null;
}

function analysisOwnerId(cell: NotebookCell): string | null {
  return typeof cell.inputs?.analysisCellId === "string"
    ? cell.inputs.analysisCellId
    : null;
}

function analysisOutputCell(
  document: NotebookDocument,
  producerCellId: string,
): NotebookCell {
  const resultEdges = document.edges.filter((edge) =>
    edge.source === producerCellId && edge.targetInput === "result");
  if (resultEdges.length !== 1) {
    throw new Error(
      `Analyze cell ${producerCellId} requires exactly one connected Analysis result cell`,
    );
  }
  const result = document.cells.find((cell) =>
    cell.id === resultEdges[0]!.target);
  if (
    result?.type !== "analysis"
    || result.inputs?.analysisRole !== "result"
    || result.inputs?.producerCellId !== producerCellId
  ) {
    throw new Error(
      `Analyze cell ${producerCellId} has an invalid Analysis result connection`,
    );
  }
  return result;
}

function outputVersionArtifactIds(
  cell: NotebookCell,
  artifactId: string,
): string[] {
  const persisted = Array.isArray(cell.inputs?.outputVersionArtifactIds)
    ? cell.inputs.outputVersionArtifactIds.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : [];
  return [...new Set([
    ...persisted,
    ...(cell.outputArtifactId ? [cell.outputArtifactId] : []),
    artifactId,
  ])];
}

function splitVideoOwnerId(cell: NotebookCell): string | null {
  return typeof cell.inputs?.splitVideoCellId === "string"
    ? cell.inputs.splitVideoCellId
    : null;
}

function featureForShot(shot: NormalizedShot): Feature | null {
  return MULTYCULTY_FEATURES[shot.ordinal - 1] ?? null;
}

function featureColumn(shot: NormalizedShot): number {
  return featureForShot(shot)?.column ?? (shot.ordinal - 1) * 2;
}

function stateForDerivedCell(cell: NotebookCell | undefined): string {
  return cell?.outputArtifactId ? "stale" : "pending";
}

function branchRole(
  kind:
    | "split-video"
    | "video"
    | "first"
    | "last"
    | "extract-audio"
    | "prompt"
    | "animate",
  ordinal: number,
): string {
  if (kind === "split-video") return `split-video-${ordinal}`;
  if (kind === "video") return `scene-video-${ordinal}`;
  if (kind === "first") return `frame-first-${ordinal}`;
  if (kind === "last") return `frame-last-${ordinal}`;
  if (kind === "extract-audio") return `scene-extract-audio-${ordinal}`;
  return `${kind}-${ordinal}`;
}

function sceneLabel(ordinal: number, suffix: string): string {
  return `Scene ${String(ordinal).padStart(2, "0")} ${suffix}`;
}

function matchesBranchChild(
  cell: NotebookCell,
  kind: BranchChildKind,
): boolean {
  if (kind === "video") return cell.type === "video";
  if (kind === "first") {
    return cell.type === "image" && cell.inputs?.frameRole === "first";
  }
  if (kind === "last") {
    return cell.type === "image" && cell.inputs?.frameRole === "last";
  }
  if (kind === "extract-audio") {
    return cell.type === "extract_audio"
      || cell.inputs?.mediaRole === EXTRACT_AUDIO_OUTPUT_ROLE;
  }
  if (kind === "prompt") return cell.type === "prompt";
  return cell.type === "generate_video";
}

function existingBranchCell(
  document: NotebookDocument,
  analysisCellId: string,
  splitVideoCellId: string,
  kind: BranchChildKind,
  ordinal: number,
): NotebookCell | undefined {
  const owned = document.cells.find((cell) =>
    analysisOwnerId(cell) === analysisCellId
    && splitVideoOwnerId(cell) === splitVideoCellId
    && matchesBranchChild(cell, kind));
  if (owned) return owned;
  return document.cells.find((cell) =>
    analysisOwnerId(cell) === analysisCellId
    && splitVideoOwnerId(cell) === null
    && roleOf(cell) === branchRole(kind, ordinal)
    && matchesBranchChild(cell, kind));
}

function existingBranchCells(
  document: NotebookDocument,
  analysisCellId: string,
  splitVideoCellId: string,
  ordinal: number,
): ExistingBranchCells {
  return {
    video: existingBranchCell(
      document,
      analysisCellId,
      splitVideoCellId,
      "video",
      ordinal,
    ),
    first: existingBranchCell(
      document,
      analysisCellId,
      splitVideoCellId,
      "first",
      ordinal,
    ),
    last: existingBranchCell(
      document,
      analysisCellId,
      splitVideoCellId,
      "last",
      ordinal,
    ),
    extractAudio: existingBranchCell(
      document,
      analysisCellId,
      splitVideoCellId,
      "extract-audio",
      ordinal,
    ),
    prompt: existingBranchCell(
      document,
      analysisCellId,
      splitVideoCellId,
      "prompt",
      ordinal,
    ),
    animate: existingBranchCell(
      document,
      analysisCellId,
      splitVideoCellId,
      "animate",
      ordinal,
    ),
  };
}

function branchCellList(branch: BranchCells): NotebookCell[] {
  return [
    branch.splitVideo,
    branch.video,
    branch.first,
    branch.last,
    branch.extractAudio,
    branch.prompt,
    branch.animate,
  ];
}

function slotKey(slot: NotebookGridSlot): string {
  return `${slot.row}:${slot.column}`;
}

function allocateBranchSlots(
  branch: BranchCells,
  retainedCellIds: Set<string>,
  occupiedSlots: Set<string>,
  sourceSlot: NotebookGridSlot | null,
): BranchCells {
  const created = branchCellList(branch).filter((cell) =>
    !retainedCellIds.has(cell.id));
  if (created.length === 0) return branch;
  const occupied: NotebookGridSlot[] = [...occupiedSlots].map((key) => {
    const [row, column] = key.split(":").map(Number);
    return { row: row!, column: column! };
  });
  const slotsByCellId = new Map<string, NotebookGridSlot>();
  let cursor = sourceSlot;
  for (const cell of created) {
    const slot = occupied.length === 0
      ? firstEmptyNotebookGridSlots([], 1)[0]!
      : isVerticalGenerationType(cell.type)
        ? nextVerticalSlotFrom(cursor ?? { row: 0, column: 0 }, occupied)
        : nextHorizontalSlotFrom(cursor ?? { row: 0, column: 0 }, occupied);
    slotsByCellId.set(cell.id, slot);
    occupied.push(slot);
    cursor = slot;
  }
  const allocate = (cell: NotebookCell): NotebookCell => {
    if (retainedCellIds.has(cell.id)) return cell;
    return {
      ...cell,
      slot: slotsByCellId.get(cell.id)!,
    };
  };
  const allocated = {
    splitVideo: allocate(branch.splitVideo),
    video: allocate(branch.video),
    first: allocate(branch.first),
    last: allocate(branch.last),
    extractAudio: allocate(branch.extractAudio),
    prompt: allocate(branch.prompt),
    animate: allocate(branch.animate),
  };
  for (const cell of branchCellList(allocated)) {
    occupiedSlots.add(slotKey(cell.slot));
  }
  return allocated;
}

function branchEdges(
  engine: Engine,
  source: NotebookCell | undefined,
  analysis: NotebookCell,
  assembly: NotebookCell | undefined,
  branch: BranchCells,
  ordinal: number,
): NotebookEdge[] {
  const edges: NotebookEdge[] = [];
  const add = (
    from: NotebookCell | undefined,
    to: NotebookCell | undefined,
    targetInput: string,
  ) => {
    if (!from || !to) return;
    edges.push(engine.notebooks.createEdge({
      source: from.id,
      target: to.id,
      targetInput,
    }));
  };
  add(source, branch.splitVideo, "video");
  add(analysis, branch.splitVideo, "analysis");
  add(branch.splitVideo, branch.video, "media");
  add(branch.video, branch.first, "segment");
  add(branch.video, branch.last, "segment");
  add(branch.video, branch.extractAudio, "segment");
  add(analysis, branch.prompt, "analysis");
  add(branch.first, branch.prompt, "first_frame");
  add(branch.last, branch.prompt, "last_frame");
  add(branch.extractAudio, branch.prompt, "scene_audio");
  add(branch.prompt, branch.animate, "prompt");
  add(branch.first, branch.animate, "first_frame");
  add(branch.last, branch.animate, "last_frame");
  add(branch.extractAudio, branch.animate, "replace_audio");
  add(branch.animate, assembly, `clip:${ordinal - 1}`);
  return edges;
}

function uniqueEdges(edges: NotebookEdge[]): NotebookEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.source}:${edge.target}:${edge.targetInput}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function gridSlot(row: number, column: number): NotebookGridSlot {
  return { row, column };
}

function buildAnalysisScriptArtifact(input: {
  request: Record<string, unknown>;
  rawOutput: unknown;
  shots: NormalizedShot[];
  sourceDurationSeconds: number;
  llmExchanges?: NotebookAnalysisLlmExchange[];
  evidence?: NotebookAnalysisEvidence;
  boundaries?: AnalysisBoundary[];
}): {
  content: string;
  legacyAnalysis: Record<string, unknown>;
} {
  const content = JSON.stringify({
    version: 3,
    request: input.request,
    llmExchanges: input.llmExchanges ?? [],
    raw: input.rawOutput,
    shots: input.shots,
    sourceDurationSeconds: input.sourceDurationSeconds,
    evidence: input.evidence ?? null,
    boundaries: input.boundaries ?? [],
    normalizedAt: new Date().toISOString(),
  }, null, 2);
  const legacyAnalysis = {
    scenes: input.shots.map((shot) => ({
      title: shot.label,
      timestamp: [shot.startSeconds, shot.endSeconds],
      prompt: shot.prompt ?? "",
    })),
  };
  return { content, legacyAnalysis };
}

function updateSplitVideoCell(
  engine: Engine,
  existing: NotebookCell | undefined,
  analysisCellId: string,
  shot: NormalizedShot,
): NotebookCell {
  const feature = featureForShot(shot);
  const column = featureColumn(shot);
  const base = existing ?? engine.notebooks.createCell({
    type: "split_video",
    label: sceneLabel(shot.ordinal, "split"),
    slot: gridSlot(2, column),
  });
  return {
    ...base,
    type: "split_video",
    label: base.label,
    slot: base.slot,
    provider: "local",
    model: undefined,
    operation: "split_range",
    tool: "ffmpeg",
    inputs: {
      ...(base.inputs ?? {}),
      analysisCellId,
      workflowRole: branchRole("split-video", shot.ordinal),
      startSeconds: shot.startSeconds,
      endSeconds: shot.endSeconds,
      ordinal: shot.ordinal,
      label: shot.label,
      featureId: feature?.id ?? `scene-${shot.ordinal}`,
      featureLabel: feature?.label ?? shot.label,
      state: stateForDerivedCell(existing),
    },
  };
}

function createBranchCells(
  engine: Engine,
  existing: ExistingBranchCells,
  analysisCellId: string,
  analysisPrompt: string,
  splitVideo: NotebookCell,
  shot: NormalizedShot,
  shotCount: number,
): BranchCells {
  const feature = featureForShot(shot);
  const column = featureColumn(shot);
  const videoRow = 3 + (shot.ordinal - 1) * 3;
  const extractionRow = videoRow + 1;
  const promptRow = 3 + shotCount * 3;
  const commonInputs = {
    analysisCellId,
    splitVideoCellId: splitVideo.id,
    ordinal: shot.ordinal,
    label: shot.label,
    startSeconds: shot.startSeconds,
    endSeconds: shot.endSeconds,
    featureId: feature?.id ?? `scene-${shot.ordinal}`,
    featureLabel: feature?.label ?? shot.label,
  };
  const videoExisting = existing.video;
  const videoBase = videoExisting ?? engine.notebooks.createCell({
    type: "video",
    label: sceneLabel(shot.ordinal, "video"),
    slot: gridSlot(videoRow, column),
  });
  const video: NotebookCell = {
    ...videoBase,
    type: "video",
    label: videoBase.label,
    slot: videoBase.slot,
    provider: undefined,
    model: undefined,
    operation: undefined,
    tool: undefined,
    inputs: {
      ...(videoBase.inputs ?? {}),
      ...commonInputs,
      workflowRole: branchRole("video", shot.ordinal),
      state: stateForDerivedCell(videoExisting),
    },
  };
  const firstExisting = existing.first;
  const firstBase = firstExisting ?? engine.notebooks.createCell({
    type: "image",
    label: sceneLabel(shot.ordinal, "first frame"),
    slot: gridSlot(extractionRow, column - 1),
  });
  const first: NotebookCell = {
    ...firstBase,
    type: "image",
    label: firstBase.label,
    slot: firstBase.slot,
    provider: undefined,
    model: undefined,
    operation: undefined,
    tool: undefined,
    inputs: {
      ...(firstBase.inputs ?? {}),
      ...commonInputs,
      workflowRole: branchRole("first", shot.ordinal),
      frameRole: "first",
      state: stateForDerivedCell(firstExisting),
    },
  };
  const lastExisting = existing.last;
  const lastBase = lastExisting ?? engine.notebooks.createCell({
    type: "image",
    label: sceneLabel(shot.ordinal, "last frame"),
    slot: gridSlot(extractionRow, column),
  });
  const last: NotebookCell = {
    ...lastBase,
    type: "image",
    label: lastBase.label,
    slot: lastBase.slot,
    provider: undefined,
    model: undefined,
    operation: undefined,
    tool: undefined,
    inputs: {
      ...(lastBase.inputs ?? {}),
      ...commonInputs,
      workflowRole: branchRole("last", shot.ordinal),
      frameRole: "last",
      state: stateForDerivedCell(lastExisting),
    },
  };
  const extractAudioExisting = existing.extractAudio;
  const extractAudioBase = extractAudioExisting
    ?? engine.notebooks.createCell({
      type: "audio",
      label: sceneLabel(shot.ordinal, "audio extract"),
      slot: gridSlot(extractionRow, column + 1),
    });
  const extractAudio: NotebookCell = {
    ...extractAudioBase,
    type: "audio",
    label: extractAudioBase.label,
    slot: extractAudioBase.slot,
    provider: undefined,
    model: undefined,
    operation: undefined,
    tool: undefined,
    inputs: {
      ...(extractAudioBase.inputs ?? {}),
      ...commonInputs,
      workflowRole: branchRole("extract-audio", shot.ordinal),
      mediaRole: EXTRACT_AUDIO_OUTPUT_ROLE,
      audioRole: "scene",
      state: stateForDerivedCell(extractAudioExisting),
    },
  };
  const promptExisting = existing.prompt;
  const promptBase = promptExisting ?? engine.notebooks.createCell({
    type: "prompt",
    label: sceneLabel(shot.ordinal, "prompt"),
    slot: gridSlot(promptRow, column),
  });
  const promptBrief = feature?.promptBrief
    ?? shot.prompt
    ?? `Animate ${shot.label} while preserving the source subjects and composition.`;
  const prompt: NotebookCell = {
    ...promptBase,
    type: "prompt",
    label: promptBase.label,
    slot: promptBase.slot,
    prompt: shot.prompt ?? promptExisting?.prompt ?? promptBrief,
    provider: "openai",
    model: INTELLIGENCE_MODEL,
    operation: "rewrite_prompt",
    tool: "rewrite_prompt",
    inputs: {
      ...(promptBase.inputs ?? {}),
      ...commonInputs,
      workflowRole: branchRole("prompt", shot.ordinal),
      targetModel: "seedance2",
      featureBrief: promptBrief,
      analysisPrompt,
      shotContext: {
        title: shot.label,
        startSeconds: shot.startSeconds,
        endSeconds: shot.endSeconds,
        durationSeconds: shot.endSeconds - shot.startSeconds,
      },
      audioContext: `Use the extracted ${shot.endSeconds - shot.startSeconds} second scene soundtrack for pacing and dialogue continuity.`,
      requiresConfirmation: true,
      state: stateForDerivedCell(promptExisting),
    },
  };
  const animateExisting = existing.animate;
  const animateBase = animateExisting ?? engine.notebooks.createCell({
    type: "generate_video",
    label: sceneLabel(shot.ordinal, "animation"),
    slot: gridSlot(promptRow + 1, column),
  });
  const animate: NotebookCell = {
    ...animateBase,
    type: "generate_video",
    label: animateBase.label,
    slot: animateBase.slot,
    prompt: "",
    provider: "kie",
    model: "bytedance/seedance-2",
    operation: "image_to_video",
    tool: DEFAULT_ANIMATION_TOOL,
    inputs: {
      ...(animateBase.inputs ?? {}),
      ...commonInputs,
      workflowRole: branchRole("animate", shot.ordinal),
      duration: "15",
      resolution: "720p",
      aspect_ratio: "16:9",
      generate_audio: false,
      requiresConfirmation: true,
      state: stateForDerivedCell(animateExisting),
    },
  };
  return {
    splitVideo,
    video,
    first,
    last,
    extractAudio,
    prompt,
    animate,
  };
}

export async function applyAnalysisResults(
  engine: Engine,
  document: NotebookDocument,
  analysisCellId: string,
  input: {
    rawOutput: unknown;
    sourceDurationSeconds: number;
    request: Record<string, unknown>;
    sourceArtifactId: string;
    llmExchanges?: NotebookAnalysisLlmExchange[];
    evidence?: NotebookAnalysisEvidence;
    boundaries?: AnalysisBoundary[];
    materializeWorkflow?: boolean;
  },
): Promise<NotebookDocument> {
  const storedAnalysisCell = document.cells.find((cell) =>
    cell.id === analysisCellId);
  if (!storedAnalysisCell) {
    throw new Error(`Analysis cell not found: ${analysisCellId}`);
  }
  const analysisCell = normalizeLegacyAnalyzeCell(storedAnalysisCell);
  const resultCell = analysisOutputCell(document, analysisCellId);
  const shots = normalizeShots(
    parseAnalysisShots(input.rawOutput),
    input.sourceDurationSeconds,
  );
  const script = buildAnalysisScriptArtifact({
    request: input.request,
    llmExchanges: input.llmExchanges,
    rawOutput: input.rawOutput,
    shots,
    sourceDurationSeconds: input.sourceDurationSeconds,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.boundaries ? { boundaries: input.boundaries } : {}),
  });
  const scriptArtifact = await engine.artifacts.create({
    kind: "script",
    label: `${analysisCell.label ?? notebookGridTag(analysisCell.slot)} analysis`,
  });
  if (!scriptArtifact.ok) throw new Error(scriptArtifact.error.message);
  const written = await engine.files.write(
    scriptArtifact.value.artifactId,
    "analysis.json",
    script.content,
  );
  if (!written.ok) throw new Error(written.error.message);
  const metadata = await engine.metadata.artifacts.write(
    scriptArtifact.value.artifactId,
    "original",
    {
      duration: input.sourceDurationSeconds,
      analysisInfo: {
        sourceDurationSeconds: input.sourceDurationSeconds,
        shots,
        boundaries: input.boundaries ?? [],
      },
    },
  );
  if (!metadata.ok) throw new Error(metadata.error.message);
  if (input.sourceArtifactId) {
    await engine.files.write(
      input.sourceArtifactId,
      ".original.analysis.json",
      JSON.stringify(script.legacyAnalysis),
    );
  }
  const updatedAnalysis: NotebookCell = {
    ...analysisCell,
    outputArtifactId: scriptArtifact.value.artifactId,
    provider: analysisCell.provider ?? "openai",
    model: analysisCell.model ?? INTELLIGENCE_MODEL,
    operation: analysisCell.operation ?? "analyze_source",
    tool: analysisCell.tool ?? OPENAI_ANALYSIS_TOOL,
    inputs: {
      ...(analysisCell.inputs ?? {}),
      shotCount: shots.length,
      sourceDurationSeconds: input.sourceDurationSeconds,
      state: "completed",
    },
  };
  const updatedResult: NotebookCell = {
    ...resultCell,
    outputArtifactId: scriptArtifact.value.artifactId,
    inputs: {
      ...(resultCell.inputs ?? {}),
      analysisRole: "result",
      producerCellId: analysisCellId,
      shotCount: shots.length,
      sourceDurationSeconds: input.sourceDurationSeconds,
      outputVersionArtifactIds: outputVersionArtifactIds(
        resultCell,
        scriptArtifact.value.artifactId,
      ),
      state: "completed",
    },
  };
  if (!input.materializeWorkflow) {
    const persisted: NotebookDocument = {
      ...document,
      cells: document.cells.map((cell) =>
        cell.id === analysisCellId
          ? updatedAnalysis
          : cell.id === resultCell.id
            ? updatedResult
            : cell),
      analysisRevision: scriptArtifact.value.artifactId,
    };
    return persisted;
  }

  const owned = document.cells.filter(
    (cell) => analysisOwnerId(cell) === analysisCellId,
  );
  const ownedSplitVideos = owned.filter((cell) =>
    cell.type === "split_video"
    && cell.operation === "split_range");
  const branches: OwnedBranch[] = ownedSplitVideos.map((cell) => ({
    cellId: cell.id,
    range: {
      startSeconds: Number(cell.inputs?.startSeconds ?? 0),
      endSeconds: Number(cell.inputs?.endSeconds ?? 0),
    },
    config: cell.inputs ?? {},
  }));
  const reconciliation = reconcileOwnedBranches(branches, shots);
  const keptSplitIds = new Set(
    reconciliation.keep.map((entry) => entry.existing.cellId),
  );
  const removedSplitIds = new Set(
    reconciliation.remove.map((entry) => entry.cellId),
  );
  const removedCellIds = new Set(
    owned
      .filter((cell) =>
        removedSplitIds.has(cell.id)
        || (
          splitVideoOwnerId(cell) !== null
          && removedSplitIds.has(splitVideoOwnerId(cell)!)
        ))
      .map((cell) => cell.id),
  );
  const baseCells = document.cells.filter((cell) => {
    if (removedCellIds.has(cell.id)) return false;
    if (cell.operation === "split_range" && analysisOwnerId(cell) === analysisCellId) {
      return keptSplitIds.has(cell.id);
    }
    return true;
  });
  const cellsWithoutOwnedBranches = baseCells.filter((cell) =>
    cell.id !== analysisCellId
    && cell.id !== resultCell.id
    && analysisOwnerId(cell) !== analysisCellId);
  const sourceCell = document.cells.find((cell) => roleOf(cell) === "source")
    ?? document.cells.find((cell) => cell.type === "video");
  const assemblyCell = document.cells.find((cell) => roleOf(cell) === "assembly")
    ?? document.cells.find((cell) => cell.operation === "concat_video");
  const branchCells: NotebookCell[] = [];
  const canonicalEdges: NotebookEdge[] = [];
  const retainedCellIds = new Set(baseCells.map((cell) => cell.id));
  const occupiedSlots = new Set(
    baseCells.map((cell) => slotKey(cell.slot)),
  );

  for (const shot of shots) {
    const kept = reconciliation.keep.find((entry) =>
      entry.shot.ordinal === shot.ordinal);
    const existingSplit = kept
      ? document.cells.find((cell) => cell.id === kept.existing.cellId)
      : undefined;
    const previousOrdinal = Number(existingSplit?.inputs?.ordinal);
    const legacyOrdinal = Number.isInteger(previousOrdinal) && previousOrdinal > 0
      ? previousOrdinal
      : shot.ordinal;
    const splitVideo = updateSplitVideoCell(
      engine,
      existingSplit,
      analysisCellId,
      shot,
    );
    const provisionalBranch = createBranchCells(
      engine,
      existingSplit
        ? existingBranchCells(
          document,
          analysisCellId,
          existingSplit.id,
          legacyOrdinal,
        )
        : {},
      analysisCellId,
      analysisCell.prompt ?? "",
      splitVideo,
      shot,
      shots.length,
    );
    const branch = allocateBranchSlots(
      provisionalBranch,
      retainedCellIds,
      occupiedSlots,
      sourceCell?.slot ?? lastCreatedCellSlot(baseCells),
    );
    branchCells.push(...branchCellList(branch));
    canonicalEdges.push(...branchEdges(
      engine,
      sourceCell,
      updatedResult,
      assemblyCell,
      branch,
      shot.ordinal,
    ));
  }

  const canonicalCellIds = new Set([
    ...owned.map((cell) => cell.id),
    ...branchCells.map((cell) => cell.id),
  ]);
  const canonicalTargetInputs = new Set([
    "source",
    "video",
    "analysis",
    "media",
    "segment",
    "first_frame",
    "last_frame",
    "scene_audio",
    "replace_audio",
    "prompt",
  ]);
  const retainedEdges = document.edges.filter((edge) => {
    if (removedCellIds.has(edge.source) || removedCellIds.has(edge.target)) {
      return false;
    }
    if (
      canonicalCellIds.has(edge.target)
      && canonicalTargetInputs.has(edge.targetInput)
    ) {
      return false;
    }
    if (
      canonicalCellIds.has(edge.source)
      && (
        edge.target === assemblyCell?.id
        || canonicalCellIds.has(edge.target)
      )
    ) {
      return false;
    }
    return true;
  });
  const cells = [
    updatedAnalysis,
    updatedResult,
    ...cellsWithoutOwnedBranches,
    ...branchCells,
  ];
  const edges = uniqueEdges([...retainedEdges, ...canonicalEdges]);
  const next: NotebookDocument = {
    ...document,
    cells,
    edges,
    workflowVersion: 7,
    analysisRevision: scriptArtifact.value.artifactId,
  };
  return {
    ...next,
    cells: next.cells.map((cell) => normalizeCellActionFields(cell, next)),
  };
}

function baseCell(
  engine: Engine,
  existing: NotebookCell | undefined,
  input: Omit<NotebookCell, "id">,
): NotebookCell {
  const created = existing ?? engine.notebooks.createCell(input);
  return {
    ...created,
    ...input,
    id: created.id,
    inputs: {
      ...(created.inputs ?? {}),
      ...(input.inputs ?? {}),
    },
  };
}

export function buildSevenStageScaffold(
  engine: Engine,
  document: NotebookDocument,
  sourceArtifactId?: string,
): NotebookDocument {
  const roleCells = new Map<string, NotebookCell>();
  for (const cell of document.cells) {
    const role = roleOf(cell);
    if (role && !roleCells.has(role)) roleCells.set(role, cell);
  }
  const occupiedSlots = document.cells.map((cell) => cell.slot);
  let lastWork = lastCreatedCellSlot(document.cells);
  const scaffoldSlot = (role: string): NotebookGridSlot => {
    const existing = roleCells.get(role);
    if (existing) return existing.slot;
    const slot = occupiedSlots.length === 0
      ? firstEmptyNotebookGridSlots([], 1)[0]!
      : nextHorizontalSlotFrom(lastWork ?? { row: 0, column: 0 }, occupiedSlots);
    occupiedSlots.push(slot);
    lastWork = slot;
    return slot;
  };
  const source = baseCell(engine, roleCells.get("source"), {
    type: "video",
    label: "Source video",
    slot: scaffoldSlot("source"),
    provider: undefined,
    operation: undefined,
    tool: undefined,
    ...(sourceArtifactId ? { outputArtifactId: sourceArtifactId } : {}),
    inputs: {
      workflowRole: "source",
      state: sourceArtifactId ? "completed" : "pending",
    },
  });
  const analysis = baseCell(engine, roleCells.get("analysis"), {
    type: "analyze",
    label: "Analyze source",
    slot: scaffoldSlot("analysis"),
    prompt: retainedAnalysisPrompt(roleCells.get("analysis")),
    provider: "openai",
    model: INTELLIGENCE_MODEL,
    operation: "analyze_source",
    tool: OPENAI_ANALYSIS_TOOL,
    inputs: { workflowRole: "analysis", state: "pending" },
  });
  const analysisOutput = baseCell(
    engine,
    roleCells.get("analysis-output"),
    {
      type: "analysis",
      label: "Analysis result",
      slot: scaffoldSlot("analysis-output"),
      provider: undefined,
      model: undefined,
      operation: undefined,
      tool: undefined,
      inputs: {
        workflowRole: "analysis-output",
        analysisRole: "result",
        producerCellId: analysis.id,
        state: "pending",
      },
    },
  );
  const extractAudio = baseCell(
    engine,
    roleCells.get("source-extract-audio"),
    {
      type: "audio",
      label: "Source audio extract",
      slot: scaffoldSlot("source-extract-audio"),
      provider: undefined,
      operation: undefined,
      tool: undefined,
      inputs: {
        workflowRole: "source-extract-audio",
        mediaRole: EXTRACT_AUDIO_OUTPUT_ROLE,
        audioRole: "continuous-source",
        state: "pending",
      },
    },
  );
  const assembly = baseCell(engine, roleCells.get("assembly"), {
    type: "concat",
    label: "Feature edit concat",
    slot: scaffoldSlot("assembly"),
    provider: "local",
    operation: "concat_video",
    tool: "ffmpeg",
    inputs: {
      workflowRole: "assembly",
      captions: MULTYCULTY_FEATURES.map((feature) => feature.caption),
      state: "pending",
    },
  });
  const baseRoles = new Set([
    "source",
    "analysis",
    "analysis-output",
    "source-extract-audio",
    "assembly",
  ]);
  const retiredRoles = new Set([
    "source-audio",
    ...MULTYCULTY_FEATURES.map((feature) => `label-${feature.ordinal}`),
  ]);
  const otherCells = document.cells.filter((cell) => {
    const role = roleOf(cell);
    return !role || (!baseRoles.has(role) && !retiredRoles.has(role));
  });
  const cells = [
    source,
    analysis,
    analysisOutput,
    extractAudio,
    assembly,
    ...otherCells,
  ];
  const baseIds = new Set([
    source.id,
    analysis.id,
    analysisOutput.id,
    extractAudio.id,
    assembly.id,
  ]);
  const retainedEdges = document.edges.filter((edge) => {
    if (!baseIds.has(edge.target)) return true;
    if (edge.target === analysis.id && edge.targetInput === "source") return false;
    if (
      edge.target === analysisOutput.id
      && edge.targetInput === "result"
    ) {
      return false;
    }
    if (
      edge.target === extractAudio.id
      && (edge.targetInput === "video" || edge.targetInput === "segment")
    ) {
      return false;
    }
    if (edge.target === assembly.id && edge.targetInput === "audio") return false;
    return true;
  });
  const edges = uniqueEdges([
    ...retainedEdges,
    engine.notebooks.createEdge({
      source: source.id,
      target: analysis.id,
      targetInput: "source",
    }),
    engine.notebooks.createEdge({
      source: analysis.id,
      target: analysisOutput.id,
      targetInput: "result",
    }),
    engine.notebooks.createEdge({
      source: source.id,
      target: extractAudio.id,
      targetInput: "segment",
    }),
    engine.notebooks.createEdge({
      source: extractAudio.id,
      target: assembly.id,
      targetInput: "audio",
    }),
  ]);
  const next: NotebookDocument = {
    ...document,
    cells,
    edges,
    workflowVersion: 7,
  };
  return {
    ...next,
    cells: next.cells.map((cell) => normalizeCellActionFields(cell, next)),
  };
}
