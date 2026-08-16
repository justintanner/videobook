import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findVideoFile,
  type Artifact,
  type Engine,
  type NotebookCell,
  type NotebookDocument,
} from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import type {
  AnalysisBoundary,
  NotebookAnalysisEvidence,
  NotebookLiveAnalysis,
} from "./notebook-live-analysis.js";
import { FFMPEG, runFfmpeg } from "./ffmpeg.js";
import { formatTimestamp, generateTimestamps } from "./frame-utils.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
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
import { sampleNotebookAnalysisFrames } from "./notebook-live-analysis.js";
import { MULTYCULTY_FIXTURE_OWNER } from "./notebook-fixtures.js";
import {
  ANALYSIS_REASONING_EFFORT,
  INTELLIGENCE_MODEL,
} from "./openai-intelligence.js";

export const MULTYCULTY_FIXTURE_VERSION = 27;

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

const SOURCE_SELECTION_LABEL = "Source selection";
const FINAL_LABEL = "Final";

const SECTION_LABELS = [
  "Intro section video",
  "Culture section video",
  "German section video",
  "Dunka section video",
] as const;

const ANIMATION_LABELS = [
  "Intro animated video",
  "Culture animated video",
] as const;

const COMPACT_FIXTURE_SLOTS = new Map<string, NotebookCell["slot"]>([
  ["source", { row: 0, column: 3 }],
  ["analysis", { row: 1, column: 2 }],
  ["source-extract-audio", { row: 1, column: 4 }],
  ["analysis-output", { row: 2, column: 2 }],
  ["split-video-1", { row: 3, column: 1 }],
  ["split-video-2", { row: 3, column: 5 }],
  ["scene-video-1", { row: 4, column: 1 }],
  ["scene-video-2", { row: 4, column: 5 }],
  ["frame-first-1", { row: 5, column: 0 }],
  ["frame-last-1", { row: 5, column: 1 }],
  ["scene-extract-audio-1", { row: 5, column: 2 }],
  ["frame-first-2", { row: 5, column: 4 }],
  ["frame-last-2", { row: 5, column: 5 }],
  ["scene-extract-audio-2", { row: 5, column: 6 }],
  ["prompt-1", { row: 6, column: 1 }],
  ["prompt-2", { row: 6, column: 5 }],
  ["animate-1", { row: 7, column: 1 }],
  ["animate-2", { row: 7, column: 5 }],
  ["assembly", { row: 8, column: 3 }],
]);

const COMPACT_FIXTURE_ROLES = new Set(COMPACT_FIXTURE_SLOTS.keys());

function requiredArtifact(
  artifacts: Artifact[],
  label: string,
): Artifact {
  const artifact = artifacts.find((candidate) => candidate.label === label);
  if (!artifact) throw new Error(`Multyculty fixture artifact is missing: ${label}`);
  return artifact;
}

async function fixtureAnalysisFramesReady(
  engine: Engine,
  sourceArtifactId: string,
): Promise<boolean> {
  const listed = engine.files.listSubdir(
    sourceArtifactId,
    "original_frames",
  );
  if (!listed.ok) return false;
  const frame = sampleNotebookAnalysisFrames(listed.value, 2)[0];
  if (!frame) return false;
  const read = await engine.files.read(
    sourceArtifactId,
    `original_frames/${frame.name}`,
  );
  return read.ok && read.value.length > 0;
}

async function ensureFixtureAnalysisFrames(
  engine: Engine,
  sourceArtifactId: string,
  durationSeconds: number,
): Promise<boolean> {
  if (await fixtureAnalysisFramesReady(engine, sourceArtifactId)) return false;
  const manifest = await engine.files.manifest(sourceArtifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const video = findVideoFile(manifest.value.files);
  if (!video) {
    throw new Error(`Multyculty source has no video file: ${sourceArtifactId}`);
  }
  const workspace = await mkdtemp(join(tmpdir(), "videobook-multyculty-frames-"));
  let lastError: unknown;
  try {
    for (const timestamp of generateTimestamps(durationSeconds)) {
      const name = `${formatTimestamp(timestamp)}.jpg`;
      const framePath = join(workspace, name);
      try {
        await runFfmpeg([
          "-y",
          "-ss", String(timestamp),
          "-i", join(manifest.value.path, video.name),
          "-frames:v", "1",
          "-q:v", "2",
          framePath,
        ]);
      } catch (error) {
        lastError = error;
        continue;
      }
      const output = await stat(framePath).catch(() => null);
      if (!output || output.size === 0) {
        lastError = new Error(`No frame at ${timestamp} seconds`);
        continue;
      }
      const written = await engine.files.writeFromPath(
        sourceArtifactId,
        `original_frames/${name}`,
        framePath,
      );
      if (!written.ok) throw new Error(written.error.message);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  if (!await fixtureAnalysisFramesReady(engine, sourceArtifactId)) {
    const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(`Multyculty source frame extraction failed${detail}`);
  }
  return true;
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
    && cells.length === 19
    && roles.size === 19
    && edges.length === 34
    && roles.has("source")
    && roles.has("analysis")
    && roles.has("analysis-output")
    && roles.has("source-extract-audio")
    && roles.has("assembly")
    && [1, 2].every((ordinal) =>
      roles.has(`split-video-${ordinal}`)
      && roles.has(`scene-video-${ordinal}`)
      && roles.has(`frame-first-${ordinal}`)
      && roles.has(`frame-last-${ordinal}`)
      && roles.has(`scene-extract-audio-${ordinal}`)
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
        ...(role === "assembly" ? { label: "Concat scenes" } : {}),
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
    label: `${cell.label ?? notebookGridTag(cell.slot)} resolved prompt`,
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
  artifacts: Artifact[],
): Promise<NotebookDocument> {
  const sourceArtifact = requiredArtifact(artifacts, SOURCE_SELECTION_LABEL);
  const promptOutputs = new Map<string, string>();
  for (const cell of document.cells) {
    if (roleOf(cell)?.startsWith("prompt-") && !cell.outputArtifactId) {
      promptOutputs.set(cell.id, await promptFixtureArtifact(engine, cell));
    }
  }
  const finalArtifact = artifacts.find((artifact) =>
    artifact.label === FINAL_LABEL);
  return {
    ...document,
    cells: document.cells.map((cell) => {
      const role = roleOf(cell);
      if (!role || !COMPACT_FIXTURE_ROLES.has(role)) return cell;
      const ordinal = ordinalForRole(cell);
      const feature = ordinal ? MULTYCULTY_FEATURES[ordinal - 1] : undefined;
      const section = ordinal
        ? artifacts.find((artifact) =>
            artifact.label === SECTION_LABELS[ordinal - 1])
        : undefined;
      const animation = ordinal && ordinal <= ANIMATION_LABELS.length
        ? artifacts.find((artifact) =>
            artifact.label === ANIMATION_LABELS[ordinal - 1])
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
    engine.artifacts.list(),
  );
  for (const feature of MULTYCULTY_FEATURES.slice(0, 2)) {
    const animation = current.cells.find((cell) =>
      roleOf(cell) === `animate-${feature.ordinal}`);
    const audio = current.cells.find((cell) =>
      roleOf(cell) === `scene-extract-audio-${feature.ordinal}`);
    if (!animation?.outputArtifactId || !audio?.outputArtifactId) {
      throw new Error(`Multyculty feature ${feature.ordinal} is missing baseline media`);
    }
    const normalized = await normalizeSceneVideo(
      engine,
      animation.outputArtifactId,
      audio.outputArtifactId,
      `${animation.label ?? notebookGridTag(animation.slot)} normalized fixture`,
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

/** Create the source media + artifacts a clean multyculty book needs before seed. */
export async function bootstrapMultycultySource(
  engine: Engine,
): Promise<void> {
  if (engine.book.get().name !== "multyculty") {
    throw new Error("The Multyculty workflow can only seed the multyculty book");
  }
  if (engine.notebooks.list().length === 0) {
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
  }
  const artifactSpecs = [
    ["video", SOURCE_SELECTION_LABEL],
    ["video", SECTION_LABELS[0]],
    ["video", SECTION_LABELS[1]],
    ["video", ANIMATION_LABELS[0]],
    ["video", ANIMATION_LABELS[1]],
    ["final", FINAL_LABEL],
  ] as const;
  const existing = new Map(
    engine.artifacts.list().flatMap((artifact) =>
      artifact.label
        ? [[artifact.label, artifact.artifactId] as const]
        : []),
  );
  const artifacts = new Map<string, string>(existing);
  for (const [kind, label] of artifactSpecs) {
    if (artifacts.has(label)) continue;
    const created = await engine.artifacts.create(kind, label);
    if (!created.ok) throw new Error(created.error.message);
    artifacts.set(label, created.value.artifactId);
  }
  const sourceId = artifacts.get(SOURCE_SELECTION_LABEL);
  if (!sourceId) {
    throw new Error(`Missing the ${SOURCE_SELECTION_LABEL} artifact`);
  }
  const sourceManifest = await engine.files.manifest(sourceId);
  const hasOriginal = sourceManifest.ok
    && sourceManifest.value.files.some((file) => file.name === "original.mp4");
  if (!hasOriginal) {
    const mediaDir = await mkdtemp(join(tmpdir(), "videobook-multyculty-media-"));
    try {
      const sourcePath = join(mediaDir, "source.mp4");
      await execFileAsync(FFMPEG, [
        "-y",
        "-f", "lavfi", "-i", "color=c=0x10261b:s=160x90:r=6:d=15",
        "-f", "lavfi", "-i", "color=c=0x274b3a:s=160x90:r=6:d=15",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=30",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[video]",
        "-map", "[video]",
        "-map", "2:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest",
        sourcePath,
      ]);
      const file = await engine.files.writeFromPath(
        sourceId,
        "original.mp4",
        sourcePath,
      );
      if (!file.ok) throw new Error(file.error.message);
      for (const label of ANIMATION_LABELS) {
        const artifactId = artifacts.get(label);
        if (!artifactId) continue;
        const animationManifest = await engine.files.manifest(artifactId);
        const animationHasOriginal = animationManifest.ok
          && animationManifest.value.files.some((entry) =>
            entry.name === "original.mp4");
        if (animationHasOriginal) continue;
        const animationFile = await engine.files.writeFromPath(
          artifactId,
          "original.mp4",
          sourcePath,
        );
        if (!animationFile.ok) throw new Error(animationFile.error.message);
      }
    } finally {
      await rm(mediaDir, { recursive: true, force: true });
    }
  }
  const manifest = await engine.files.manifest(sourceId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const objectHash = manifest.value.files.find((entry) =>
    entry.name === "original.mp4")?.objectHash
    ?? manifest.value.files[0]?.objectHash;
  if (!objectHash) throw new Error("Source media missing object hash");
  const streams = engine.streams.list(sourceId);
  const hasAudio = streams.ok
    && streams.value.some((stream) => stream.kind === "audio");
  if (!hasAudio) {
    const stream = await engine.streams.register({
      artifactId: sourceId,
      sourcePath: "original.mp4",
      objectHash,
      streamIndex: 1,
      kind: "audio",
      timeBase: { numerator: 1, denominator: 48_000 },
      durationTicks: 1_440_000,
      codec: "aac",
      audio: {
        sampleRateHz: 48_000,
        channels: 2,
        channelLayout: "stereo",
      },
    });
    if (!stream.ok) throw new Error(stream.error.message);
  }
}

export async function seedMultycultyWorkflow(
  engine: Engine,
  options: {
    materializeLocalOutputs?: boolean;
  } = {},
): Promise<NotebookDocument> {
  if (engine.book.get().name !== "multyculty") {
    throw new Error("The Multyculty workflow can only seed the multyculty book");
  }
  await bootstrapMultycultySource(engine);
  const notebook = engine.notebooks.list().find((candidate) =>
    candidate.name.toLowerCase() === "multyculty")
    ?? engine.notebooks.list()[0];
  if (!notebook) throw new Error("The Multyculty book has no notebook");
  const artifacts = engine.artifacts.list();
  const sourceArtifact = requiredArtifact(artifacts, SOURCE_SELECTION_LABEL);
  await ensureFixtureAnalysisFrames(engine, sourceArtifact.artifactId, 30);
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
      if (roleOf(cell) === "source-extract-audio") {
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
      materializeWorkflow: true,
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
