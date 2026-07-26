import type {
  Engine,
  NotebookCell,
  NotebookDocument,
  NotebookEdge,
  NotebookGridSlot,
} from "videobook-engine";
import {
  DEFAULT_ANIMATION_TOOL,
  normalizeCellActionFields,
} from "./notebook-action-catalog.js";
import {
  normalizeShots,
  parseAnalysisShots,
  reconcileOwnedBranches,
  type NormalizedShot,
  type OwnedBranch,
} from "./notebook-shots.js";

export const WORKFLOW_STAGES = [
  "VIDEO",
  "ANALYZE",
  "SPLIT VIDEO",
  "EXTRACT ASSETS",
  "WRITE PROMPTS",
  "GENERATE VIDEO",
  "CONCAT",
] as const;

export const MULTYCULTY_FEATURES = [
  {
    ordinal: 1,
    id: "import-analyze",
    label: "Import + Analyze",
    feature: "Source import and automatic shot analysis",
    caption: "FEATURE 01 · IMPORT + ANALYZE",
    promptBrief:
      "Preserve the seated subject and original composition while a refined filmstrip, waveform, and precise scene markers materialize around the source. Show the app turning one imported video into an understood edit without adding text.",
    column: -2,
  },
  {
    ordinal: 2,
    id: "split-extract",
    label: "Split + Extract",
    feature: "Scene splitting and reusable media extraction",
    caption: "FEATURE 02 · SPLIT + EXTRACT",
    promptBrief:
      "Preserve the people, car, and location while the moment separates into elegant first-frame, last-frame, and audio-wave components connected by clean editorial motion. Show reusable scene assets without adding text.",
    column: -1,
  },
  {
    ordinal: 3,
    id: "prompt-animate",
    label: "Prompt + Animate",
    feature: "Asset-grounded prompt writing and animation",
    caption: "FEATURE 03 · PROMPT + ANIMATE",
    promptBrief:
      "Preserve the character performance and identity while an abstract prompt ribbon becomes controlled motion paths that travel from the first frame to the last frame. Show grounded animation direction without adding text.",
    column: 1,
  },
  {
    ordinal: 4,
    id: "assemble-export",
    label: "Concatenate",
    feature: "Synchronized playable video concatenation",
    caption: "FEATURE 04 · CONCATENATE",
    promptBrief:
      "Preserve the dialogue scene and natural performance while four luminous editorial lanes converge into one synchronized landscape timeline and a polished finished master. Show completion and continuity without adding text.",
    column: 2,
  },
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

type Feature = (typeof MULTYCULTY_FEATURES)[number];

interface BranchCells {
  splitVideo: NotebookCell;
  video: NotebookCell;
  first: NotebookCell;
  last: NotebookCell;
  extractAudio: NotebookCell;
  audio: NotebookCell;
  prompt: NotebookCell;
  animate: NotebookCell;
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

function splitVideoOwnerId(cell: NotebookCell): string | null {
  return typeof cell.inputs?.splitVideoCellId === "string"
    ? cell.inputs.splitVideoCellId
    : null;
}

function featureForShot(shot: NormalizedShot): Feature | null {
  return MULTYCULTY_FEATURES[shot.ordinal - 1] ?? null;
}

function featureColumn(shot: NormalizedShot): number {
  return featureForShot(shot)?.column ?? (shot.ordinal - 1) * 2 - 3;
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
    | "audio"
    | "prompt"
    | "animate",
  ordinal: number,
): string {
  if (kind === "split-video") return `split-video-${ordinal}`;
  if (kind === "video") return `scene-video-${ordinal}`;
  if (kind === "first") return `frame-first-${ordinal}`;
  if (kind === "last") return `frame-last-${ordinal}`;
  if (kind === "extract-audio") return `scene-extract-audio-${ordinal}`;
  if (kind === "audio") return `scene-audio-${ordinal}`;
  return `${kind}-${ordinal}`;
}

function branchCell(
  document: NotebookDocument,
  role: string,
): NotebookCell | undefined {
  return document.cells.find((cell) => roleOf(cell) === role);
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
  add(branch.video, branch.extractAudio, "video");
  add(branch.extractAudio, branch.audio, "media");
  add(analysis, branch.prompt, "analysis");
  add(branch.first, branch.prompt, "first_frame");
  add(branch.last, branch.prompt, "last_frame");
  add(branch.audio, branch.prompt, "scene_audio");
  add(branch.prompt, branch.animate, "prompt");
  add(branch.first, branch.animate, "first_frame");
  add(branch.last, branch.animate, "last_frame");
  add(branch.audio, branch.animate, "replace_audio");
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

export function workflowStageForCell(cell: NotebookCell): WorkflowStage {
  if (cell.type === "video") return "VIDEO";
  if (cell.type === "analyze") return "ANALYZE";
  if (cell.type === "split_video") return "SPLIT VIDEO";
  if (
    cell.type === "extract_audio"
    || cell.type === "image"
    || cell.type === "audio"
  ) {
    return "EXTRACT ASSETS";
  }
  if (cell.type === "prompt") return "WRITE PROMPTS";
  if (cell.type === "generate_video") return "GENERATE VIDEO";
  if (cell.type === "concat") return "CONCAT";
  return "VIDEO";
}

export function gridSlot(row: number, column: number): NotebookGridSlot {
  return { row, column };
}

export function buildAnalysisScriptArtifact(input: {
  request: Record<string, unknown>;
  rawOutput: unknown;
  shots: NormalizedShot[];
  sourceDurationSeconds: number;
}): {
  content: string;
  legacyAnalysis: Record<string, unknown>;
} {
  const content = JSON.stringify({
    version: 2,
    request: input.request,
    raw: input.rawOutput,
    shots: input.shots,
    sourceDurationSeconds: input.sourceDurationSeconds,
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
    title: "",
    slot: gridSlot(2, column),
  });
  return {
    ...base,
    type: "split_video",
    title: `@split-video-${String(shot.ordinal).padStart(2, "0")} · ${shot.label}`,
    slot: gridSlot(2, column),
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
  document: NotebookDocument,
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
  const audioRow = videoRow + 2;
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
  const videoExisting = branchCell(
    document,
    branchRole("video", shot.ordinal),
  );
  const videoBase = videoExisting ?? engine.notebooks.createCell({
    type: "video",
    title: "",
    slot: gridSlot(videoRow, column),
  });
  const video: NotebookCell = {
    ...videoBase,
    type: "video",
    title: `@scene-video-${String(shot.ordinal).padStart(2, "0")} · ${shot.label}`,
    slot: gridSlot(videoRow, column),
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
  const firstExisting = branchCell(
    document,
    branchRole("first", shot.ordinal),
  );
  const firstBase = firstExisting ?? engine.notebooks.createCell({
    type: "image",
    title: "",
    slot: gridSlot(extractionRow, column - 1),
  });
  const first: NotebookCell = {
    ...firstBase,
    type: "image",
    title: `@frame-${String(shot.ordinal).padStart(2, "0")} · first`,
    slot: gridSlot(extractionRow, column - 1),
    provider: "local",
    model: undefined,
    operation: "capture_frame",
    tool: "ffmpeg",
    inputs: {
      ...(firstBase.inputs ?? {}),
      ...commonInputs,
      workflowRole: branchRole("first", shot.ordinal),
      frameRole: "first",
      state: stateForDerivedCell(firstExisting),
    },
  };
  const lastExisting = branchCell(
    document,
    branchRole("last", shot.ordinal),
  );
  const lastBase = lastExisting ?? engine.notebooks.createCell({
    type: "image",
    title: "",
    slot: gridSlot(extractionRow, column),
  });
  const last: NotebookCell = {
    ...lastBase,
    type: "image",
    title: `@frame-${String(shot.ordinal).padStart(2, "0")} · last`,
    slot: gridSlot(extractionRow, column),
    provider: "local",
    model: undefined,
    operation: "capture_frame",
    tool: "ffmpeg",
    inputs: {
      ...(lastBase.inputs ?? {}),
      ...commonInputs,
      workflowRole: branchRole("last", shot.ordinal),
      frameRole: "last",
      state: stateForDerivedCell(lastExisting),
    },
  };
  const extractAudioExisting = branchCell(
    document,
    branchRole("extract-audio", shot.ordinal),
  );
  const extractAudioBase = extractAudioExisting
    ?? engine.notebooks.createCell({
      type: "extract_audio",
      title: "",
      slot: gridSlot(extractionRow, column + 1),
    });
  const extractAudio: NotebookCell = {
    ...extractAudioBase,
    type: "extract_audio",
    title: `@extract-audio-${String(shot.ordinal).padStart(2, "0")} · scene`,
    slot: gridSlot(extractionRow, column + 1),
    provider: "local",
    model: undefined,
    operation: "extract_audio",
    tool: "ffmpeg",
    inputs: {
      ...(extractAudioBase.inputs ?? {}),
      ...commonInputs,
      workflowRole: branchRole("extract-audio", shot.ordinal),
      audioRole: "scene",
      state: stateForDerivedCell(extractAudioExisting),
    },
  };
  const audioExisting = branchCell(
    document,
    branchRole("audio", shot.ordinal),
  );
  const audioBase = audioExisting ?? engine.notebooks.createCell({
    type: "audio",
    title: "",
    slot: gridSlot(audioRow, column + 1),
  });
  const audio: NotebookCell = {
    ...audioBase,
    type: "audio",
    title: `@audio-${String(shot.ordinal).padStart(2, "0")} · scene`,
    slot: gridSlot(audioRow, column + 1),
    provider: undefined,
    model: undefined,
    operation: undefined,
    tool: undefined,
    inputs: {
      ...(audioBase.inputs ?? {}),
      ...commonInputs,
      workflowRole: branchRole("audio", shot.ordinal),
      audioRole: "scene",
      state: stateForDerivedCell(audioExisting),
    },
  };
  const promptExisting = branchCell(
    document,
    branchRole("prompt", shot.ordinal),
  );
  const promptBase = promptExisting ?? engine.notebooks.createCell({
    type: "prompt",
    title: "",
    slot: gridSlot(promptRow, column),
  });
  const promptBrief = feature?.promptBrief
    ?? shot.prompt
    ?? `Animate ${shot.label} while preserving the source subjects and composition.`;
  const prompt: NotebookCell = {
    ...promptBase,
    type: "prompt",
    title: `@prompt-${String(shot.ordinal).padStart(2, "0")} · ${feature?.label ?? shot.label}`,
    slot: gridSlot(promptRow, column),
    prompt: shot.prompt ?? promptExisting?.prompt ?? promptBrief,
    provider: "openai",
    model: "gpt-5.2",
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
  const animateExisting = branchCell(
    document,
    branchRole("animate", shot.ordinal),
  );
  const animateBase = animateExisting ?? engine.notebooks.createCell({
    type: "generate_video",
    title: "",
    slot: gridSlot(promptRow + 1, column),
  });
  const animate: NotebookCell = {
    ...animateBase,
    type: "generate_video",
    title: `@animate-${String(shot.ordinal).padStart(2, "0")} · ${feature?.label ?? shot.label}`,
    slot: gridSlot(promptRow + 1, column),
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
    audio,
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
  },
): Promise<NotebookDocument> {
  const analysisCell = document.cells.find((cell) => cell.id === analysisCellId);
  if (!analysisCell) throw new Error(`Analysis cell not found: ${analysisCellId}`);
  const shots = normalizeShots(
    parseAnalysisShots(input.rawOutput),
    input.sourceDurationSeconds,
  );
  const script = buildAnalysisScriptArtifact({
    request: input.request,
    rawOutput: input.rawOutput,
    shots,
    sourceDurationSeconds: input.sourceDurationSeconds,
  });
  const scriptArtifact = await engine.artifacts.create({
    kind: "script",
    name: `${analysisCell.title} analysis`,
  });
  if (!scriptArtifact.ok) throw new Error(scriptArtifact.error.message);
  const written = await engine.files.write(
    scriptArtifact.value.artifactId,
    "analysis.json",
    script.content,
  );
  if (!written.ok) throw new Error(written.error.message);
  if (input.sourceArtifactId) {
    await engine.files.write(
      input.sourceArtifactId,
      ".original.analysis.json",
      JSON.stringify(script.legacyAnalysis),
    );
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
  const updatedAnalysis: NotebookCell = {
    ...analysisCell,
    outputArtifactId: scriptArtifact.value.artifactId,
    provider: analysisCell.provider ?? "kie",
    model: analysisCell.model ?? "gemini-3.5-flash",
    operation: analysisCell.operation ?? "analyze_source",
    tool: analysisCell.tool ?? "kie_gemini_analysis",
    inputs: {
      ...(analysisCell.inputs ?? {}),
      shotCount: shots.length,
      sourceDurationSeconds: input.sourceDurationSeconds,
      state: "completed",
    },
  };
  const cellsWithoutOwnedBranches = baseCells.filter((cell) =>
    cell.id !== analysisCellId
    && analysisOwnerId(cell) !== analysisCellId);
  const sourceCell = document.cells.find((cell) => roleOf(cell) === "source")
    ?? document.cells.find((cell) => cell.type === "video");
  const assemblyCell = document.cells.find((cell) => roleOf(cell) === "assembly")
    ?? document.cells.find((cell) => cell.operation === "concat_video");
  const branchCells: NotebookCell[] = [];
  const canonicalEdges: NotebookEdge[] = [];

  for (const shot of shots) {
    const kept = reconciliation.keep.find((entry) =>
      entry.shot.ordinal === shot.ordinal);
    const existingSplit = kept
      ? document.cells.find((cell) => cell.id === kept.existing.cellId)
      : undefined;
    const splitVideo = updateSplitVideoCell(
      engine,
      existingSplit,
      analysisCellId,
      shot,
    );
    const branch = createBranchCells(
      engine,
      document,
      analysisCellId,
      analysisCell.prompt ?? "",
      splitVideo,
      shot,
      shots.length,
    );
    branchCells.push(
      branch.splitVideo,
      branch.video,
      branch.first,
      branch.last,
      branch.extractAudio,
      branch.audio,
      branch.prompt,
      branch.animate,
    );
    canonicalEdges.push(...branchEdges(
      engine,
      sourceCell,
      updatedAnalysis,
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
    ...cellsWithoutOwnedBranches,
    ...branchCells,
  ];
  const edges = uniqueEdges([...retainedEdges, ...canonicalEdges]);
  const next: NotebookDocument = {
    ...document,
    cells,
    edges,
    properties: {
      ...(document.properties ?? {}),
      workflowVersion: 6,
      analysisRevision: scriptArtifact.value.artifactId,
    },
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
  const source = baseCell(engine, roleCells.get("source"), {
    type: "video",
    title: "@start · source",
    slot: gridSlot(0, 0),
    provider: "local",
    operation: "preprocess_source",
    tool: "ffmpeg",
    ...(sourceArtifactId ? { outputArtifactId: sourceArtifactId } : {}),
    inputs: {
      workflowRole: "source",
      state: sourceArtifactId ? "completed" : "pending",
    },
  });
  const analysis = baseCell(engine, roleCells.get("analysis"), {
    type: "analyze",
    title: "@splitter · analyze",
    slot: gridSlot(1, 0),
    prompt: "Segment the source into four continuous 15-second narrative shots with precise timestamps and concise visual context.",
    provider: "kie",
    model: "gemini-3.5-flash",
    operation: "analyze_source",
    tool: "kie_gemini_analysis",
    inputs: { workflowRole: "analysis", state: "pending" },
  });
  const extractAudio = baseCell(
    engine,
    roleCells.get("source-extract-audio"),
    {
      type: "extract_audio",
      title: "@extract-audio · continuous source",
      slot: gridSlot(0, 1),
      provider: "local",
      operation: "extract_audio",
      tool: "ffmpeg",
      inputs: {
        workflowRole: "source-extract-audio",
        audioRole: "continuous-source",
        state: "pending",
      },
    },
  );
  const audio = baseCell(engine, roleCells.get("source-audio"), {
    type: "audio",
    title: "@audio · continuous source",
    slot: gridSlot(1, 1),
    provider: undefined,
    model: undefined,
    operation: undefined,
    tool: undefined,
    inputs: {
      workflowRole: "source-audio",
      audioRole: "continuous-source",
      state: "pending",
    },
  });
  const assembly = baseCell(engine, roleCells.get("assembly"), {
    type: "concat",
    title: "@concat · feature edit",
    slot: gridSlot(18, 0),
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
    "source-extract-audio",
    "source-audio",
    "assembly",
  ]);
  const retiredRoles = new Set(
    MULTYCULTY_FEATURES.map((feature) => `label-${feature.ordinal}`),
  );
  const otherCells = document.cells.filter((cell) => {
    const role = roleOf(cell);
    return !role || (!baseRoles.has(role) && !retiredRoles.has(role));
  });
  const cells = [
    source,
    analysis,
    extractAudio,
    audio,
    assembly,
    ...otherCells,
  ];
  const baseIds = new Set([
    source.id,
    analysis.id,
    extractAudio.id,
    audio.id,
    assembly.id,
  ]);
  const retainedEdges = document.edges.filter((edge) => {
    if (!baseIds.has(edge.target)) return true;
    if (edge.target === analysis.id && edge.targetInput === "source") return false;
    if (edge.target === extractAudio.id && edge.targetInput === "video") {
      return false;
    }
    if (edge.target === audio.id && edge.targetInput === "media") return false;
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
      source: source.id,
      target: extractAudio.id,
      targetInput: "video",
    }),
    engine.notebooks.createEdge({
      source: extractAudio.id,
      target: audio.id,
      targetInput: "media",
    }),
    engine.notebooks.createEdge({
      source: audio.id,
      target: assembly.id,
      targetInput: "audio",
    }),
  ]);
  const next: NotebookDocument = {
    ...document,
    cells,
    edges,
    properties: {
      ...(document.properties ?? {}),
      workflowVersion: 6,
    },
  };
  return {
    ...next,
    cells: next.cells.map((cell) => normalizeCellActionFields(cell, next)),
  };
}
