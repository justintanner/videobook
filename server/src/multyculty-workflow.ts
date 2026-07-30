import type {
  Engine,
  NotebookCell,
  NotebookDocument,
} from "videobook-engine";
import type { BookManager } from "./book-manager.js";
import {
  notebookCellFingerprint,
  runNotebookCell,
  topologicalOrder,
} from "./jobs/run-notebook.js";
import { normalizeSceneVideo } from "./notebook-media-ops.js";
import {
  applyAnalysisResults,
  buildSevenStageScaffold,
  DEFAULT_ANALYSIS_PROMPT,
  MULTYCULTY_FEATURES,
} from "./notebook-workflow.js";
import type {
  AnalysisBoundary,
  NotebookAnalysisEvidence,
  NotebookLiveAnalysis,
} from "./notebook-live-analysis.js";
import { MULTYCULTY_FIXTURE_OWNER } from "./notebook-fixtures.js";
import {
  ANALYSIS_REASONING_EFFORT,
  INTELLIGENCE_MODEL,
} from "./openai-intelligence.js";

type ArtifactRecord = {
  artifactId: string;
  slug: string;
  kind: string;
};

export const MULTYCULTY_FIXTURE_VERSION = 24;

const MULTYCULTY_FIXTURE_ANALYSIS: NotebookLiveAnalysis["rawOutput"] = {
  shots: [
    {
      startSeconds: 0,
      endSeconds: 15,
      label: "intro",
      prompt: "Opening presenter shot establishing the discussion.",
    },
    {
      startSeconds: 15,
      endSeconds: 30,
      label: "culture",
      prompt: "The camera switches for the follow-up discussion beat.",
    },
  ],
};

const MULTYCULTY_FIXTURE_LLM_EXCHANGES: NotebookLiveAnalysis["llmExchanges"] = [{
  provider: "openai",
  model: INTELLIGENCE_MODEL,
  stage: "notebook_shot_labels",
  input: {
    model: INTELLIGENCE_MODEL,
    reasoning: { effort: ANALYSIS_REASONING_EFFORT },
    store: false,
    instructions: "Return one concise label and prompt for every supplied shot.",
    input: [{
      role: "user",
      content: [{
        type: "input_text",
        text: [
          DEFAULT_ANALYSIS_PROMPT,
          "Source duration: 30 seconds.",
          "Verified boundaries: 0 seconds, 15 seconds, 30 seconds.",
          "Shot 1 opens on the presenter; shot 2 is the follow-up discussion beat.",
        ].join("\n"),
      }],
    }],
  },
  response: {
    id: "resp_multyculty_analysis_fixture",
    object: "response",
    created_at: 1,
    status: "completed",
    model: INTELLIGENCE_MODEL,
    output: [{
      type: "message",
      id: "msg_multyculty_analysis_fixture",
      role: "assistant",
      status: "completed",
      content: [{
        type: "output_text",
        text: JSON.stringify(MULTYCULTY_FIXTURE_ANALYSIS),
        annotations: [],
      }],
    }],
  },
}];

const MULTYCULTY_FIXTURE_EVIDENCE: NotebookAnalysisEvidence = {
  visualCandidates: [{
    id: "visual-001",
    timestampSeconds: 15,
    score: 42,
    frameTimestamps: [14.5, 14.9, 15.1, 15.5],
  }],
  visualDecisions: [{
    candidateId: "visual-001",
    accepted: true,
    cameraSwitch: true,
    transitionType: "hard_cut",
    confidence: 0.98,
    rechecked: false,
  }],
  audioCandidates: [],
  selectedAudioCandidateIds: [],
  transcript: {
    included: false,
    timed: false,
  },
};

const MULTYCULTY_FIXTURE_BOUNDARIES: AnalysisBoundary[] = [
  {
    id: "boundary-source-start",
    timestampSeconds: 0,
    kind: "source_start",
    confidence: 1,
    evidenceIds: [],
  },
  {
    id: "boundary-camera-001",
    timestampSeconds: 15,
    kind: "camera_cut",
    confidence: 0.98,
    evidenceIds: ["visual-001"],
  },
  {
    id: "boundary-source-end",
    timestampSeconds: 30,
    kind: "source_end",
    confidence: 1,
    evidenceIds: [],
  },
];

const SECTION_SLUGS = [
  "vid-section-intro",
  "vid-section-culture",
  "vid-section-german",
  "vid-section-dunka",
] as const;

const ANIMATION_SLUGS = [
  "vid-animated-intro",
  "vid-animated-culture",
] as const;

const COMPACT_FIXTURE_SLOTS = new Map<string, NotebookCell["slot"]>([
  ["source", { row: 0, column: 0 }],
  ["source-extract-audio", { row: 0, column: 1 }],
  ["analysis", { row: 1, column: 0 }],
  ["source-audio", { row: 1, column: 1 }],
  ["analysis-output", { row: 2, column: 0 }],
  ["split-video-1", { row: 2, column: -2 }],
  ["split-video-2", { row: 2, column: 2 }],
  ["scene-video-1", { row: 3, column: -2 }],
  ["scene-video-2", { row: 3, column: 2 }],
  ["frame-first-1", { row: 4, column: -3 }],
  ["frame-last-1", { row: 4, column: -2 }],
  ["scene-extract-audio-1", { row: 4, column: -1 }],
  ["frame-first-2", { row: 4, column: 1 }],
  ["frame-last-2", { row: 4, column: 2 }],
  ["scene-extract-audio-2", { row: 4, column: 3 }],
  ["scene-audio-1", { row: 5, column: -1 }],
  ["scene-audio-2", { row: 5, column: 3 }],
  ["prompt-1", { row: 5, column: -2 }],
  ["prompt-2", { row: 5, column: 2 }],
  ["animate-1", { row: 6, column: -2 }],
  ["animate-2", { row: 6, column: 2 }],
  ["assembly", { row: 7, column: 0 }],
]);

const COMPACT_FIXTURE_ROLES = new Set(COMPACT_FIXTURE_SLOTS.keys());

function requiredArtifact(
  artifacts: ArtifactRecord[],
  slug: string,
): ArtifactRecord {
  const artifact = artifacts.find((candidate) => candidate.slug === slug);
  if (!artifact) throw new Error(`Multyculty fixture artifact is missing: ${slug}`);
  return artifact;
}

function roleOf(cell: NotebookCell): string | null {
  return typeof cell.inputs?.workflowRole === "string"
    ? cell.inputs.workflowRole
    : null;
}

function isCanonicalRole(role: string | null): boolean {
  return role === "source"
    || role === "analysis"
    || role === "analysis-output"
    || role === "source-extract-audio"
    || role === "source-audio"
    || role === "assembly"
    || /^split-video-\d+$/.test(role ?? "")
    || /^scene-video-\d+$/.test(role ?? "")
    || /^frame-(first|last)-\d+$/.test(role ?? "")
    || /^scene-extract-audio-\d+$/.test(role ?? "")
    || /^scene-audio-\d+$/.test(role ?? "")
    || /^prompt-\d+$/.test(role ?? "")
    || /^animate-\d+$/.test(role ?? "");
}

function fixtureRecord(document: NotebookDocument): Record<string, unknown> | null {
  const raw = document.fixture;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
}

function canonicalFixtureCells(document: NotebookDocument): NotebookCell[] {
  return document.cells.filter((cell) =>
    cell.inputs?.fixtureOwner === MULTYCULTY_FIXTURE_OWNER);
}

function hasRunnableAnalysisFixture(document: NotebookDocument): boolean {
  return document.cells.some((cell) =>
    roleOf(cell) === "analysis"
    && cell.inputs?.fixtureOwner === MULTYCULTY_FIXTURE_OWNER
    && (
      cell.inputs.fixtureAnalysis !== undefined
      || cell.inputs.analysisFixture !== undefined
    ));
}

function withoutRunnableAnalysisFixture(
  document: NotebookDocument,
): NotebookDocument {
  let changed = false;
  const cells = document.cells.map((cell) => {
    if (
      roleOf(cell) !== "analysis"
      || cell.inputs?.fixtureOwner !== MULTYCULTY_FIXTURE_OWNER
      || (
        cell.inputs.fixtureAnalysis === undefined
        && cell.inputs.analysisFixture === undefined
      )
    ) {
      return cell;
    }
    const inputs = { ...cell.inputs };
    delete inputs.fixtureAnalysis;
    delete inputs.analysisFixture;
    changed = true;
    return { ...cell, inputs };
  });
  return changed ? { ...document, cells } : document;
}

function isCurrentFixture(document: NotebookDocument): boolean {
  const fixture = fixtureRecord(document);
  const cells = canonicalFixtureCells(document);
  const roles = new Set(cells.map(roleOf));
  const cellIds = new Set(cells.map((cell) => cell.id));
  const edges = document.edges.filter((edge) =>
    cellIds.has(edge.source) && cellIds.has(edge.target));
  return fixture?.version === MULTYCULTY_FIXTURE_VERSION
    && cells.length === 22
    && roles.size === 22
    && edges.length === 37
    && roles.has("source")
    && roles.has("analysis")
    && roles.has("analysis-output")
    && roles.has("source-extract-audio")
    && roles.has("source-audio")
    && roles.has("assembly")
    && [1, 2].every((ordinal) =>
      roles.has(`split-video-${ordinal}`)
      && roles.has(`scene-video-${ordinal}`)
      && roles.has(`frame-first-${ordinal}`)
      && roles.has(`frame-last-${ordinal}`)
      && roles.has(`scene-extract-audio-${ordinal}`)
      && roles.has(`scene-audio-${ordinal}`)
      && roles.has(`prompt-${ordinal}`)
      && roles.has(`animate-${ordinal}`));
}

function ordinalForRole(cell: NotebookCell): number | null {
  const match = roleOf(cell)?.match(/-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function compactFixture(document: NotebookDocument): NotebookDocument {
  const cells = document.cells
    .filter((cell) => COMPACT_FIXTURE_ROLES.has(roleOf(cell) ?? ""))
    .map((cell) => {
      const role = roleOf(cell);
      const slot = role ? COMPACT_FIXTURE_SLOTS.get(role) : undefined;
      if (!slot) return cell;
      return {
        ...cell,
        slot,
        ...(role === "assembly" ? { slug: "concat-scenes" } : {}),
      };
    });
  const cellIds = new Set(cells.map((cell) => cell.id));
  return {
    ...document,
    cells,
    edges: document.edges.filter((edge) =>
      cellIds.has(edge.source) && cellIds.has(edge.target)),
  };
}

async function promptFixtureArtifact(
  engine: Engine,
  cell: NotebookCell,
): Promise<string> {
  const artifact = await engine.artifacts.create({
    kind: "script",
    name: `script ${cell.slug} resolved prompt`,
  });
  if (!artifact.ok) throw new Error(artifact.error.message);
  const result = {
    version: 1,
    source: "multyculty-precomputed-fixture",
    originalPrompt: cell.prompt ?? "",
    resolvedPrompt: cell.prompt ?? "",
    featureId: cell.inputs?.featureId ?? null,
    featureBrief: cell.inputs?.featureBrief ?? null,
    shotContext: cell.inputs?.shotContext ?? null,
    audioContext: cell.inputs?.audioContext ?? null,
  };
  const written = await engine.files.write(
    artifact.value.artifactId,
    "prompt.json",
    JSON.stringify(result, null, 2),
  );
  if (!written.ok) throw new Error(written.error.message);
  return artifact.value.artifactId;
}

async function attachFixtureOutputs(
  engine: Engine,
  document: NotebookDocument,
  artifacts: ArtifactRecord[],
): Promise<NotebookDocument> {
  const sourceArtifact = requiredArtifact(artifacts, "vid-source-selection");
  const promptOutputs = new Map<string, string>();
  for (const cell of document.cells) {
    if (roleOf(cell)?.startsWith("prompt-") && !cell.outputArtifactId) {
      promptOutputs.set(cell.id, await promptFixtureArtifact(engine, cell));
    }
  }
  const finalArtifact = artifacts.find((artifact) => artifact.slug === "final");
  return {
    ...document,
    cells: document.cells.map((cell) => {
      const role = roleOf(cell);
      if (!role || !COMPACT_FIXTURE_ROLES.has(role)) return cell;
      const ordinal = ordinalForRole(cell);
      const feature = ordinal ? MULTYCULTY_FEATURES[ordinal - 1] : undefined;
      const section = ordinal
        ? artifacts.find((artifact) => artifact.slug === SECTION_SLUGS[ordinal - 1])
        : undefined;
      const animation = ordinal && ordinal <= ANIMATION_SLUGS.length
        ? artifacts.find((artifact) =>
            artifact.slug === ANIMATION_SLUGS[ordinal - 1])
        : undefined;
      const promptOutput = promptOutputs.get(cell.id);
      const outputArtifactId = role === "source"
        ? sourceArtifact.artifactId
        : role?.startsWith("scene-video-")
          ? cell.outputArtifactId ?? section?.artifactId
          : role.startsWith("animate-")
            ? cell.outputArtifactId ?? animation?.artifactId
            : role.startsWith("prompt-")
              ? cell.outputArtifactId ?? promptOutput
              : role === "assembly"
                ? cell.outputArtifactId ?? finalArtifact?.artifactId
                : cell.outputArtifactId;
      const completed = Boolean(outputArtifactId);
      return {
        ...cell,
        ...(outputArtifactId ? { outputArtifactId } : {}),
        inputs: {
          ...(cell.inputs ?? {}),
          fixtureOwner: MULTYCULTY_FIXTURE_OWNER,
          ...(feature
            ? {
                featureId: feature.id,
                featureLabel: feature.label,
                featureCaption: feature.caption,
              }
            : {}),
          ...(role.startsWith("animate-")
            ? {
                fixtureBaseline: true,
                requiresConfirmation: true,
              }
            : {}),
          ...(role.startsWith("prompt-")
            ? { resolvedPrompt: cell.prompt ?? "" }
            : {}),
          state: completed ? "completed" : "pending",
        },
      };
    }),
  };
}

function fixtureExecution(
  document: NotebookDocument,
): NonNullable<NotebookDocument["execution"]> {
  const execution = { ...(document.execution ?? {}) };
  const completedAt = new Date().toISOString();
  for (const cell of canonicalFixtureCells(document)) {
    if (!cell.outputArtifactId) continue;
    execution[cell.id] = {
      status: "completed",
      outputArtifactId: cell.outputArtifactId,
      completedAt,
      fixtureBaseline: true,
    };
  }
  return execution;
}

async function writeNotebook(
  engine: Engine,
  document: NotebookDocument,
): Promise<NotebookDocument> {
  const written = await engine.notebooks.write(document);
  if (!written.ok) throw new Error(written.error.message);
  const read = engine.notebooks.read(document.id);
  if (!read.ok) throw new Error(read.error.message);
  return read.value;
}

async function runFixtureRole(
  engine: Engine,
  document: NotebookDocument,
  role: string,
): Promise<NotebookDocument> {
  const cell = document.cells.find((candidate) => roleOf(candidate) === role);
  if (!cell) throw new Error(`Multyculty fixture cell is missing: ${role}`);
  const result = await runNotebookCell(
    engine,
    engine.book.get().bookId,
    document.id,
    document,
    cell,
  );
  return result.document;
}

async function materializeLocalOutputs(
  engine: Engine,
  document: NotebookDocument,
): Promise<NotebookDocument> {
  let current = document;
  for (const ordered of topologicalOrder(current)) {
    if (
      ordered.inputs?.fixtureOwner !== MULTYCULTY_FIXTURE_OWNER
      || (
        ordered.operation !== "split_range"
        && ordered.operation !== "extract_audio"
      )
    ) {
      continue;
    }
    const cell = current.cells.find((candidate) => candidate.id === ordered.id);
    if (!cell) throw new Error(`Multyculty fixture cell disappeared: ${ordered.id}`);
    const result = await runNotebookCell(
      engine,
      engine.book.get().bookId,
      current.id,
      current,
      cell,
    );
    current = result.document;
  }
  current = await attachFixtureOutputs(
    engine,
    current,
    engine.artifacts.list() as ArtifactRecord[],
  );
  for (const feature of MULTYCULTY_FEATURES.slice(0, 2)) {
    const animation = current.cells.find((cell) =>
      roleOf(cell) === `animate-${feature.ordinal}`);
    const audio = current.cells.find((cell) =>
      roleOf(cell) === `scene-audio-${feature.ordinal}`);
    if (!animation?.outputArtifactId || !audio?.outputArtifactId) {
      throw new Error(`Multyculty feature ${feature.ordinal} is missing baseline media`);
    }
    const normalized = await normalizeSceneVideo(
      engine,
      animation.outputArtifactId,
      audio.outputArtifactId,
      `${animation.slug} normalized fixture`,
      15,
    );
    current = await writeNotebook(engine, {
      ...current,
      cells: current.cells.map((cell) =>
        cell.id === animation.id
          ? {
              ...cell,
              outputArtifactId: normalized.artifactId,
              inputs: {
                ...(cell.inputs ?? {}),
                normalizedFromArtifactId: animation.outputArtifactId,
                normalizedDurationSeconds: normalized.durationSeconds,
                state: "completed",
              },
            }
          : cell),
    });
  }
  current = await runFixtureRole(engine, current, "assembly");
  const completedAt = new Date().toISOString();
  const completedCells = current.cells.map((cell) =>
    cell.inputs?.fixtureOwner === MULTYCULTY_FIXTURE_OWNER
      && cell.outputArtifactId
      ? {
          ...cell,
          inputs: {
            ...(cell.inputs ?? {}),
            state: "completed",
          },
        }
      : cell);
  const completedDocument = { ...current, cells: completedCells };
  const execution = {
    ...fixtureExecution(completedDocument),
  };
  for (const cell of completedCells) {
    if (
      cell.inputs?.fixtureOwner !== MULTYCULTY_FIXTURE_OWNER
      || !cell.outputArtifactId
    ) {
      continue;
    }
    execution[cell.id] = {
      status: "completed",
      fingerprint: notebookCellFingerprint(completedDocument, cell),
      outputArtifactId: cell.outputArtifactId,
      completedAt,
      updatedAt: completedAt,
      fixtureBaseline: true,
    };
  }
  const fixture = fixtureRecord(completedDocument) ?? {};
  return writeNotebook(engine, {
    ...completedDocument,
    execution,
    lifecycleState: "finished",
    fixture: {
      ...fixture,
      materializedAt: completedAt,
      noPaidCalls: true,
    },
  });
}

export async function seedMultycultyWorkflow(
  engine: Engine,
  options: {
    materializeLocalOutputs?: boolean;
  } = {},
): Promise<NotebookDocument> {
  if (engine.book.get().slug !== "multyculty") {
    throw new Error("The Multyculty workflow can only seed the multyculty book");
  }
  const notebook = engine.notebooks.list().find((candidate) =>
    candidate.name.toLowerCase() === "multyculty")
    ?? engine.notebooks.list()[0];
  if (!notebook) throw new Error("The Multyculty book has no notebook");
  if (isCurrentFixture(notebook)) {
    const runnable = withoutRunnableAnalysisFixture(notebook);
    const persisted = runnable === notebook
      ? notebook
      : await writeNotebook(engine, runnable);
    const fixture = fixtureRecord(persisted);
    if (
      options.materializeLocalOutputs
      && typeof fixture?.materializedAt !== "string"
    ) {
      return materializeLocalOutputs(engine, persisted);
    }
    return persisted;
  }

  const artifacts = engine.artifacts.list() as ArtifactRecord[];
  const sourceArtifact = requiredArtifact(artifacts, "vid-source-selection");
  const streams = engine.streams.list(sourceArtifact.artifactId);
  if (!streams.ok) throw new Error(streams.error.message);
  const sourceAudio = streams.value.find((stream) => stream.kind === "audio");
  if (!sourceAudio) throw new Error("The Multyculty source has no audio stream");
  const previousRevision = engine.head;
  const scaffold = buildSevenStageScaffold(
    engine,
    {
      ...notebook,
      cells: [],
      edges: [],
      execution: {},
      generationPlans: [],
      notebookRunPlans: [],
    },
    sourceArtifact.artifactId,
  );
  const source = scaffold.cells.find((cell) => roleOf(cell) === "source");
  const analysis = scaffold.cells.find((cell) => roleOf(cell) === "analysis");
  if (!source || !analysis) {
    throw new Error("Multyculty scaffold missing source or analysis workflow roles");
  }
  const configured: NotebookDocument = {
    ...scaffold,
    cells: scaffold.cells.map((cell) => {
      if (cell.id === source.id) {
        return {
          ...cell,
          outputArtifactId: sourceArtifact.artifactId,
          inputs: {
            ...(cell.inputs ?? {}),
            sourceProject: "multiculty",
            sourceTitle: "We Were WRONG About Rupert Lowe",
            sourceUrl: "https://www.youtube.com/watch?v=b-3853ow72Q",
            selectedRangeSeconds: [1490, 1520],
            streamId: sourceAudio.streamId,
            objectHash: sourceAudio.objectHash,
            state: "completed",
          },
        };
      }
      if (cell.id === analysis.id) {
        return {
          ...cell,
          prompt: cell.prompt ?? DEFAULT_ANALYSIS_PROMPT,
          inputs: {
            ...(cell.inputs ?? {}),
            sourceDurationSeconds: 30,
            state: "pending",
          },
        };
      }
      if (roleOf(cell) === "source-audio") {
        return {
          ...cell,
          outputArtifactId: undefined,
          inputs: {
            ...(cell.inputs ?? {}),
            artifactId: sourceArtifact.artifactId,
            streamId: sourceAudio.streamId,
            objectHash: sourceAudio.objectHash,
            state: "pending",
          },
        };
      }
      return cell;
    }),
  };
  const fanned = await applyAnalysisResults(
    engine,
    configured,
    analysis.id,
    {
      rawOutput: MULTYCULTY_FIXTURE_ANALYSIS,
      sourceDurationSeconds: 30,
      request: {
        mode: "multyculty-fixture",
        provider: "openai",
        model: INTELLIGENCE_MODEL,
        reasoning: { effort: ANALYSIS_REASONING_EFFORT },
        pipelineVersion: 3,
        stages: [
          "visual_candidate_detection",
          "camera_validation",
          "audio_boundary_selection",
          "shot_labeling",
        ],
      },
      sourceArtifactId: sourceArtifact.artifactId,
      llmExchanges: MULTYCULTY_FIXTURE_LLM_EXCHANGES,
      evidence: MULTYCULTY_FIXTURE_EVIDENCE,
      boundaries: MULTYCULTY_FIXTURE_BOUNDARIES,
    },
  );
  const withOutputs = await attachFixtureOutputs(
    engine,
    compactFixture(fanned),
    artifacts,
  );
  const fixtureOwnedIds = new Set(
    withOutputs.cells
      .filter((cell) => isCanonicalRole(roleOf(cell)))
      .map((cell) => cell.id),
  );
  const migrated: NotebookDocument = {
    ...withOutputs,
    name: "Multyculty",
    cells: withOutputs.cells.map((cell) =>
      fixtureOwnedIds.has(cell.id)
        ? {
            ...cell,
            inputs: {
              ...(cell.inputs ?? {}),
              fixtureOwner: MULTYCULTY_FIXTURE_OWNER,
            },
          }
        : cell),
    description:
      "Compact offline example from source analysis through two generated scenes and a playable concat.",
    lifecycleState: "finished",
    fixture: {
      version: MULTYCULTY_FIXTURE_VERSION,
      owner: MULTYCULTY_FIXTURE_OWNER,
      previousRevision,
      ensuredAt: new Date().toISOString(),
      noPaidCalls: true,
    },
  };
  migrated.execution = fixtureExecution(migrated);
  const seeded = await writeNotebook(engine, migrated);
  return options.materializeLocalOutputs
    ? materializeLocalOutputs(engine, seeded)
    : seeded;
}

export async function ensureMultycultyWorkflow(
  books: BookManager,
  options: {
    materializeLocalOutputs?: boolean;
  } = {},
): Promise<{
  status: "skipped" | "unchanged" | "migrated";
  notebookId?: string;
  revision?: string;
}> {
  await books.ready();
  const selected = books.getBySlug("multyculty");
  if (!selected.ok) return { status: "skipped" };
  const notebook = selected.value.engine.notebooks.list().find((candidate) =>
    candidate.name.toLowerCase() === "multyculty")
    ?? selected.value.engine.notebooks.list()[0];
  if (!notebook) return { status: "skipped" };
  const source = selected.value.engine.artifacts.list().find((artifact) =>
    artifact.slug === "vid-source-selection");
  if (!source) return { status: "skipped" };
  const fixture = fixtureRecord(notebook);
  if (
    isCurrentFixture(notebook)
    && !hasRunnableAnalysisFixture(notebook)
    && (
      !options.materializeLocalOutputs
      || typeof fixture?.materializedAt === "string"
    )
  ) {
    return {
      status: "unchanged",
      notebookId: notebook.id,
      revision: selected.value.engine.head,
    };
  }
  const migrated = await seedMultycultyWorkflow(
    selected.value.engine,
    options,
  );
  return {
    status: "migrated",
    notebookId: migrated.id,
    revision: selected.value.engine.head,
  };
}
