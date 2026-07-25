import type {
  Engine,
  NotebookCell,
  NotebookDocument,
  NotebookEdge,
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
  "SOURCE",
  "ANALYZE",
  "SPLIT + AUDIO",
  "CAPTURE FRAMES",
  "ANIMATE",
  "ASSEMBLE",
  "EXPORT",
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

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

export function workflowStageForCell(cell: NotebookCell): WorkflowStage {
  switch (cell.type) {
    case "source":
      return "SOURCE";
    case "analysis":
      return "ANALYZE";
    case "split":
    case "audio":
      return "SPLIT + AUDIO";
    case "frame":
      return "CAPTURE FRAMES";
    case "video":
    case "image":
      return "ANIMATE";
    case "sequence":
      return "ASSEMBLE";
    case "export":
      return "EXPORT";
    default:
      return "SOURCE";
  }
}

export function gridPosition(stageIndex: number, column: number) {
  return {
    x: 120 + column * 320,
    y: 48 + stageIndex * 280,
  };
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
    version: 1,
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
  const ownedSplits = owned.filter((cell) => cell.type === "split");
  const branches: OwnedBranch[] = ownedSplits.map((cell) => ({
    cellId: cell.id,
    range: {
      startSeconds: Number(cell.inputs?.startSeconds ?? 0),
      endSeconds: Number(cell.inputs?.endSeconds ?? 0),
    },
    config: cell.inputs ?? {},
  }));
  const reconcile = reconcileOwnedBranches(branches, shots);

  const keepIds = new Set(reconcile.keep.map((entry) => entry.existing.cellId));
  const removeIds = new Set(reconcile.remove.map((entry) => entry.cellId));
  // Remove owned split/frame/video branches that no longer match.
  const retainedCells = document.cells.filter((cell) => {
    if (analysisOwnerId(cell) !== analysisCellId) return true;
    if (cell.type === "split") return keepIds.has(cell.id);
    if (cell.type === "frame" || cell.type === "video") {
      const parentSplit = typeof cell.inputs?.splitCellId === "string"
        ? cell.inputs.splitCellId
        : null;
      return parentSplit ? keepIds.has(parentSplit) : !removeIds.has(cell.id);
    }
    return true;
  });

  const cells: NotebookCell[] = retainedCells.map((cell) => {
    if (cell.id === analysisCellId) {
      return {
        ...cell,
        outputArtifactId: scriptArtifact.value.artifactId,
        provider: cell.provider ?? "kie",
        model: cell.model ?? "gemini-3.5-flash",
        operation: cell.operation ?? "analyze_source",
        tool: cell.tool ?? "kie_gemini_analysis",
        inputs: {
          ...(cell.inputs ?? {}),
          shotCount: shots.length,
          sourceDurationSeconds: input.sourceDurationSeconds,
          state: "completed",
        },
      };
    }
    const kept = reconcile.keep.find((entry) => entry.existing.cellId === cell.id);
    if (kept && cell.type === "split") {
      return {
        ...cell,
        title: `@split-${String(kept.shot.ordinal).padStart(2, "0")} · ${kept.shot.label}`,
        position: gridPosition(2, kept.shot.ordinal - 1),
        inputs: {
          ...cell.inputs,
          ...kept.existing.config,
          analysisCellId,
          startSeconds: kept.shot.startSeconds,
          endSeconds: kept.shot.endSeconds,
          ordinal: kept.shot.ordinal,
          label: kept.shot.label,
          state: "stale",
        },
      };
    }
    return cell;
  });

  const newCells: NotebookCell[] = [];
  const newEdges: NotebookEdge[] = [];
  const sourceCell = cells.find((cell) => cell.type === "source")
    ?? cells.find((cell) => roleOf(cell) === "source");

  for (const shot of reconcile.create) {
    const split = engine.notebooks.createCell({
      type: "split",
      title: `@split-${String(shot.ordinal).padStart(2, "0")} · ${shot.label}`,
      position: gridPosition(2, shot.ordinal - 1),
      provider: "local",
      operation: "split_range",
      tool: "ffmpeg",
      inputs: {
        analysisCellId,
        workflowRole: `split-${shot.ordinal}`,
        startSeconds: shot.startSeconds,
        endSeconds: shot.endSeconds,
        ordinal: shot.ordinal,
        label: shot.label,
        state: "pending",
      },
    });
    const first = engine.notebooks.createCell({
      type: "frame",
      title: `@frame-${String(shot.ordinal).padStart(2, "0")} · first`,
      position: gridPosition(3, shot.ordinal * 2 - 2),
      provider: "local",
      operation: "capture_frame",
      tool: "ffmpeg",
      inputs: {
        analysisCellId,
        splitCellId: split.id,
        workflowRole: `frame-first-${shot.ordinal}`,
        frameRole: "first",
        state: "pending",
      },
    });
    const last = engine.notebooks.createCell({
      type: "frame",
      title: `@frame-${String(shot.ordinal).padStart(2, "0")} · last`,
      position: gridPosition(3, shot.ordinal * 2 - 1),
      provider: "local",
      operation: "capture_frame",
      tool: "ffmpeg",
      inputs: {
        analysisCellId,
        splitCellId: split.id,
        workflowRole: `frame-last-${shot.ordinal}`,
        frameRole: "last",
        state: "pending",
      },
    });
    const animate = engine.notebooks.createCell({
      type: "video",
      title: `@animate-${String(shot.ordinal).padStart(2, "0")}`,
      position: gridPosition(4, shot.ordinal - 1),
      prompt: shot.prompt ?? analysisCell.prompt ?? "",
      provider: "kie",
      model: "bytedance/seedance-2",
      operation: "image_to_video",
      tool: DEFAULT_ANIMATION_TOOL,
      inputs: {
        analysisCellId,
        splitCellId: split.id,
        workflowRole: `animate-${shot.ordinal}`,
        state: "pending",
        requiresConfirmation: true,
      },
    });
    newCells.push(split, first, last, animate);
    if (sourceCell) {
      newEdges.push(
        engine.notebooks.createEdge({
          source: sourceCell.id,
          target: split.id,
          targetInput: "source",
        }),
      );
    }
    newEdges.push(
      engine.notebooks.createEdge({
        source: analysisCellId,
        target: split.id,
        targetInput: "analysis",
      }),
      engine.notebooks.createEdge({
        source: split.id,
        target: first.id,
        targetInput: "segment",
      }),
      engine.notebooks.createEdge({
        source: split.id,
        target: last.id,
        targetInput: "segment",
      }),
      engine.notebooks.createEdge({
        source: split.id,
        target: animate.id,
        targetInput: "segment",
      }),
      engine.notebooks.createEdge({
        source: first.id,
        target: animate.id,
        targetInput: "first_frame",
      }),
      engine.notebooks.createEdge({
        source: last.id,
        target: animate.id,
        targetInput: "last_frame",
      }),
    );
  }

  // Drop edges that reference removed cells.
  const cellIds = new Set([
    ...cells.map((cell) => cell.id),
    ...newCells.map((cell) => cell.id),
  ]);
  const edges = [
    ...document.edges.filter(
      (edge) => cellIds.has(edge.source) && cellIds.has(edge.target),
    ),
    ...newEdges,
  ];

  return {
    ...document,
    cells: [
      ...cells.map((cell) => normalizeCellActionFields(cell, {
        ...document,
        cells: [...cells, ...newCells],
        edges,
      })),
      ...newCells,
    ],
    edges,
    properties: {
      ...(document.properties ?? {}),
      stageLabels: [...WORKFLOW_STAGES],
      analysisRevision: scriptArtifact.value.artifactId,
    },
  };
}

export function buildSevenStageScaffold(
  engine: Engine,
  document: NotebookDocument,
  sourceArtifactId?: string,
): NotebookDocument {
  const existingRoles = new Map(
    document.cells
      .map((cell) => [roleOf(cell), cell] as const)
      .filter((entry): entry is [string, NotebookCell] => Boolean(entry[0])),
  );

  const source = existingRoles.get("source") ?? engine.notebooks.createCell({
    type: "source",
    title: "@source",
    position: gridPosition(0, 0),
    provider: "local",
    operation: "preprocess_source",
    tool: "ffmpeg",
    ...(sourceArtifactId ? { outputArtifactId: sourceArtifactId } : {}),
    inputs: { workflowRole: "source", state: sourceArtifactId ? "completed" : "pending" },
  });
  const analysis = existingRoles.get("analysis") ?? engine.notebooks.createCell({
    type: "analysis",
    title: "@analyze",
    position: gridPosition(1, 0),
    prompt: "Segment the source into continuous narrative shots with timestamps.",
    provider: "kie",
    model: "gemini-3.5-flash",
    operation: "analyze_source",
    tool: "kie_gemini_analysis",
    inputs: { workflowRole: "analysis", state: "pending" },
  });
  const audio = existingRoles.get("source-audio") ?? engine.notebooks.createCell({
    type: "audio",
    title: "@audio",
    position: gridPosition(2, 8),
    provider: "local",
    operation: "extract_audio",
    tool: "ffmpeg",
    inputs: { workflowRole: "source-audio", state: "pending" },
  });
  const assembly = existingRoles.get("assembly") ?? engine.notebooks.createCell({
    type: "sequence",
    title: "@assemble",
    position: gridPosition(5, 0),
    provider: "local",
    operation: "assemble_sequence",
    tool: "engine_sequence",
    inputs: { workflowRole: "assembly", state: "pending" },
  });
  const exp = existingRoles.get("export") ?? engine.notebooks.createCell({
    type: "export",
    title: "@export",
    position: gridPosition(6, 0),
    provider: "local",
    operation: "export_master",
    tool: "ffmpeg",
    inputs: { workflowRole: "export", state: "pending" },
  });

  const scaffoldCells = [source, analysis, audio, assembly, exp];
  const otherCells = document.cells.filter((cell) => {
    const role = roleOf(cell);
    return !role
      || !["source", "analysis", "source-audio", "assembly", "export"].includes(role);
  });
  const cells = [...scaffoldCells, ...otherCells];
  const edgeKey = (edge: NotebookEdge) =>
    `${edge.source}->${edge.target}:${edge.targetInput}`;
  const edges = [...document.edges];
  const ensureEdge = (
    sourceCell: NotebookCell,
    targetCell: NotebookCell,
    targetInput: string,
  ) => {
    const exists = edges.some((edge) =>
      edge.source === sourceCell.id
      && edge.target === targetCell.id
      && edge.targetInput === targetInput);
    if (exists) return;
    edges.push(engine.notebooks.createEdge({
      source: sourceCell.id,
      target: targetCell.id,
      targetInput,
    }));
  };
  ensureEdge(source, analysis, "source");
  ensureEdge(source, audio, "source");
  ensureEdge(audio, assembly, "audio");
  ensureEdge(assembly, exp, "sequence");
  void edgeKey;

  return {
    ...document,
    cells,
    edges,
    properties: {
      ...(document.properties ?? {}),
      stageLabels: [...WORKFLOW_STAGES],
    },
  };
}
