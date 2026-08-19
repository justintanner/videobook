import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { YtDlp } from "ytdlp-nodejs";
import {
  findVideoFile,
  resolveNotebookCellArtifactId,
  type Artifact,
  type Engine,
  type NotebookCell,
  type NotebookDocument,
} from "videobook-engine";
import type { BookManager } from "./book-manager.js";
import { probeImage } from "./image.js";
import { notebookCellFingerprint } from "./jobs/run-notebook.js";
import { probeVideo, runFfmpeg } from "./ffmpeg.js";
type DancingFixtureOptions = {
  sourceVideoPath?: string;
  kittenImagePath?: string;
};

export const DANCING_FIXTURE_OWNER = "dancing-default";
export const DANCING_FIXTURE_VERSION = 6;
const DANCING_SOURCE_URL = "https://www.youtube.com/watch?v=8GwZveBYRJI";
export const DANCING_MOTION_DURATION_SECONDS = 10;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_KITTEN_IMAGE_PATH = resolve(
  __dirname,
  "../../public/dancing-kittens-first-frame.png",
);
const SOURCE_LABEL = "Dancing motion reference";
const FIRST_FRAME_LABEL = "Dancing first frame";
const KITTEN_IMAGE_LABEL = "Kittens freeway first frame";
const IMAGE_PROMPT = "Replace the two dancers with two kittens standing in the same pose on the shoulder at the side of a freeway.";
const MOTION_PROMPT = "Two kittens perform the same synchronized dance as the reference video while standing on the freeway shoulder.";
const FIXTURE_ROLES = [
  "download-video",
  "extract-first-frame",
  "kittens-freeway",
  "kittens-freeway-output",
  "kling-motion-control",
  "kling-motion-control-output",
] as const;

function roleOf(cell: NotebookCell): string | null {
  return typeof cell.inputs?.workflowRole === "string"
    ? cell.inputs.workflowRole
    : null;
}

function fixtureRecord(document: NotebookDocument): Record<string, unknown> | null {
  const fixture = document.fixture;
  return fixture && typeof fixture === "object" && !Array.isArray(fixture)
    ? fixture as Record<string, unknown>
    : null;
}

function fixtureCells(document: NotebookDocument): NotebookCell[] {
  return document.cells.filter((cell) =>
    cell.inputs?.fixtureOwner === DANCING_FIXTURE_OWNER);
}

function isCurrentFixture(document: NotebookDocument): boolean {
  const cells = fixtureCells(document);
  const cellIds = new Set(cells.map((cell) => cell.id));
  const roles = new Set(cells.map(roleOf));
  const edges = document.edges.filter((edge) =>
    cellIds.has(edge.source) && cellIds.has(edge.target));
  return fixtureRecord(document)?.version === DANCING_FIXTURE_VERSION
    && cells.length === FIXTURE_ROLES.length
    && FIXTURE_ROLES.every((role) => roles.has(role))
    && edges.length === 6
    && cells.filter((cell) => cell.outputArtifactId).every((cell) =>
      document.execution?.[cell.id]?.fingerprint
        === notebookCellFingerprint(document, cell));
}

function requiredArtifact(
  artifacts: Artifact[],
  label: string,
): Artifact {
  const artifact = artifacts.find((candidate) => candidate.label === label);
  if (!artifact) throw new Error(`Dancing fixture artifact is missing: ${label}`);
  return artifact;
}

async function ensureArtifact(
  engine: Engine,
  kind: "video" | "image",
  label: string,
): Promise<Artifact> {
  const existing = engine.artifacts.list().find((artifact) =>
    artifact.label === label);
  if (existing) return existing;
  const created = await engine.artifacts.create({ kind, label });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

async function hasFile(
  engine: Engine,
  artifactId: string,
  filename: string,
): Promise<boolean> {
  const manifest = await engine.files.manifest(artifactId);
  return manifest.ok
    && manifest.value.files.some((file) => file.name === filename);
}

async function downloadDancingVideo(destination: string): Promise<void> {
  const ytdlp = new YtDlp();
  await ytdlp
    .download(DANCING_SOURCE_URL)
    .setOutputTemplate(destination)
    .addArgs("--merge-output-format", "mp4")
    .addArgs("--no-playlist")
    .run();
}

async function ensureSourceVideo(
  engine: Engine,
  artifact: Artifact,
  options: DancingFixtureOptions,
): Promise<void> {
  if (await hasFile(engine, artifact.artifactId, "original.mp4")) return;
  const workspace = await mkdtemp(join(tmpdir(), "videobook-dancing-source-"));
  try {
    const downloadedPath = join(workspace, "downloaded.mp4");
    const sourcePath = options.sourceVideoPath ?? downloadedPath;
    if (!options.sourceVideoPath) await downloadDancingVideo(downloadedPath);
    const clippedPath = join(workspace, "motion-reference.mp4");
    await runFfmpeg([
      "-y",
      "-i", sourcePath,
      "-t", String(DANCING_MOTION_DURATION_SECONDS),
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ac", "2",
      "-movflags", "+faststart",
      clippedPath,
    ]);
    const probe = await probeVideo(clippedPath);
    if (probe.duration < 3 || probe.duration > 30) {
      throw new Error(`Dancing motion reference must be 3-30 seconds, got ${probe.duration}`);
    }
    const written = await engine.files.writeFromPath(
      artifact.artifactId,
      "original.mp4",
      clippedPath,
    );
    if (!written.ok) throw new Error(written.error.message);
    const metadata = await engine.metadata.artifacts.write(
      artifact.artifactId,
      "original",
      {
        origin: "download",
        source_url: DANCING_SOURCE_URL,
        title: "Dancing motion reference",
        selected_range_seconds: [0, DANCING_MOTION_DURATION_SECONDS],
        width: probe.width,
        height: probe.height,
        duration: probe.duration,
        hasAudio: probe.hasAudio,
        fixture: true,
      },
    );
    if (!metadata.ok) throw new Error(metadata.error.message);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function ensureFirstFrame(
  engine: Engine,
  source: Artifact,
  frame: Artifact,
): Promise<void> {
  if (await hasFile(engine, frame.artifactId, "original.jpg")) return;
  const sourceManifest = await engine.files.manifest(source.artifactId);
  if (!sourceManifest.ok) throw new Error(sourceManifest.error.message);
  const video = findVideoFile(sourceManifest.value.files);
  if (!video) throw new Error("Dancing fixture source has no video file");
  const workspace = await mkdtemp(join(tmpdir(), "videobook-dancing-frame-"));
  try {
    const framePath = join(workspace, "first-frame.jpg");
    await runFfmpeg([
      "-y",
      "-ss", "0.1",
      "-i", join(sourceManifest.value.path, video.name),
      "-frames:v", "1",
      "-q:v", "2",
      framePath,
    ]);
    const written = await engine.files.writeFromPath(
      frame.artifactId,
      "original.jpg",
      framePath,
    );
    if (!written.ok) throw new Error(written.error.message);
    const image = await engine.files.read(frame.artifactId, "original.jpg");
    if (!image.ok) throw new Error(image.error.message);
    const dimensions = await probeImage(image.value);
    const metadata = await engine.metadata.artifacts.write(
      frame.artifactId,
      "original",
      {
        origin: "first_frame",
        source_asset: source.artifactId,
        timestamp: 0.1,
        ...dimensions,
        fixture: true,
      },
    );
    if (!metadata.ok) throw new Error(metadata.error.message);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function ensureKittenImage(
  engine: Engine,
  frame: Artifact,
  kitten: Artifact,
  options: DancingFixtureOptions,
): Promise<void> {
  if (await hasFile(engine, kitten.artifactId, "original.png")) return;
  const imagePath = options.kittenImagePath ?? DEFAULT_KITTEN_IMAGE_PATH;
  const written = await engine.files.writeFromPath(
    kitten.artifactId,
    "original.png",
    imagePath,
  );
  if (!written.ok) throw new Error(written.error.message);
  const image = await engine.files.read(kitten.artifactId, "original.png");
  if (!image.ok) throw new Error(image.error.message);
  const dimensions = await probeImage(image.value);
  const metadata = await engine.metadata.artifacts.write(
    kitten.artifactId,
    "original",
    {
      origin: "fixture_baseline",
      source_asset: frame.artifactId,
      prompt: IMAGE_PROMPT,
      provider: "codex-imagegen",
      ...dimensions,
      fixture: true,
    },
  );
  if (!metadata.ok) throw new Error(metadata.error.message);
}

async function bootstrapDancingAssets(
  engine: Engine,
  options: DancingFixtureOptions = {},
): Promise<void> {
  if (engine.book.get().name !== "dancing") {
    throw new Error("The Dancing workflow can only seed the dancing book");
  }
  if (engine.notebooks.list().length === 0) {
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
  }
  const source = await ensureArtifact(engine, "video", SOURCE_LABEL);
  const frame = await ensureArtifact(engine, "image", FIRST_FRAME_LABEL);
  const kitten = await ensureArtifact(engine, "image", KITTEN_IMAGE_LABEL);
  await ensureSourceVideo(engine, source, options);
  await ensureFirstFrame(engine, source, frame);
  await ensureKittenImage(engine, frame, kitten, options);
}

function completedExecution(
  document: NotebookDocument,
  preserved: NonNullable<NotebookDocument["execution"]>,
): NonNullable<NotebookDocument["execution"]> {
  const execution = { ...preserved };
  const completedAt = new Date().toISOString();
  for (const cell of fixtureCells(document)) {
    const artifactId = resolveNotebookCellArtifactId(document, cell);
    if (!artifactId) continue;
    execution[cell.id] = {
      status: "completed",
      fingerprint: notebookCellFingerprint(document, cell),
      outputArtifactId: artifactId,
      completedAt,
      updatedAt: completedAt,
      ...(cell.tool ? { tool: cell.tool } : {}),
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

export async function seedDancingWorkflow(
  engine: Engine,
  options: DancingFixtureOptions = {},
): Promise<NotebookDocument> {
  if (engine.book.get().name !== "dancing") {
    throw new Error("The Dancing workflow can only seed the dancing book");
  }
  await bootstrapDancingAssets(engine, options);
  const notebook = engine.notebooks.list().find((candidate) =>
    candidate.name.toLowerCase() === "dancing kittens")
    ?? engine.notebooks.list()[0];
  if (!notebook) throw new Error("The Dancing book has no notebook");
  if (isCurrentFixture(notebook)) return notebook;

  const artifacts = engine.artifacts.list();
  const sourceArtifact = requiredArtifact(artifacts, SOURCE_LABEL);
  const frameArtifact = requiredArtifact(artifacts, FIRST_FRAME_LABEL);
  const kittenArtifact = requiredArtifact(artifacts, KITTEN_IMAGE_LABEL);
  const previousFixtureCells = fixtureCells(notebook);
  const previousFixtureIds = new Set(previousFixtureCells.map((cell) => cell.id));
  const preservedCells = notebook.cells.filter((cell) =>
    !previousFixtureIds.has(cell.id));
  const preservedEdges = notebook.edges.filter((edge) =>
    !previousFixtureIds.has(edge.source) && !previousFixtureIds.has(edge.target));
  const preservedExecution = Object.fromEntries(
    Object.entries(notebook.execution ?? {}).filter(([cellId]) =>
      !previousFixtureIds.has(cellId)),
  );
  const ownedInputs = (workflowRole: string): Record<string, unknown> => ({
    fixtureOwner: DANCING_FIXTURE_OWNER,
    workflowRole,
  });

  const source = engine.notebooks.createCell({
    type: "video",
    label: "Dancing reference video",
    slot: { row: 0, column: 0 },
    outputArtifactId: sourceArtifact.artifactId,
    inputs: {
      ...ownedInputs("download-video"),
      sourceOperation: "download_video",
      sourceUrl: DANCING_SOURCE_URL,
      selectedRangeSeconds: [0, DANCING_MOTION_DURATION_SECONDS],
      durationSeconds: DANCING_MOTION_DURATION_SECONDS,
      state: "completed",
    },
  });
  const extract = engine.notebooks.createCell({
    type: "image",
    label: "First frame",
    slot: { row: 1, column: 0 },
    outputArtifactId: frameArtifact.artifactId,
    inputs: {
      ...ownedInputs("extract-first-frame"),
      mediaRole: "extract-frame-output",
      sourceCellId: source.id,
      atSeconds: 0.1,
      frameMode: "first",
      state: "completed",
    },
  });
  const kittens = engine.notebooks.createCell({
    type: "generate_image",
    label: "Generate kittens freeway image",
    slot: { row: 2, column: 1 },
    prompt: IMAGE_PROMPT,
    provider: "google_flow",
    model: "googleflow/image/nano-banana-pro",
    operation: "text_to_image",
    tool: "generate_google_flow_nano_banana_pro_image",
    inputs: {
      ...ownedInputs("kittens-freeway"),
      generationMode: "default",
      generationSettings: { aspect_ratio: "9:16" },
      fixtureBaseline: true,
      requiresConfirmation: true,
      state: "completed",
    },
  });
  const kittenOutput = engine.notebooks.createCell({
    type: "image",
    label: "Kittens freeway image",
    slot: { row: 3, column: 1 },
    outputArtifactId: kittenArtifact.artifactId,
    inputs: {
      ...ownedInputs("kittens-freeway-output"),
      mediaRole: "generate-image-output",
      producerCellId: kittens.id,
      fixtureBaseline: true,
      state: "completed",
    },
  });
  const motion = engine.notebooks.createCell({
    type: "generate_video",
    label: "Kittens dancing motion",
    slot: { row: 3, column: 2 },
    prompt: MOTION_PROMPT,
    provider: "kie",
    model: "kling-3.0/motion-control",
    operation: "motion_control",
    tool: "generate_kie_kling_3_0_motion_control",
    inputs: {
      ...ownedInputs("kling-motion-control"),
      generationMode: "default",
      generationSettings: {
        mode: "720p",
        character_orientation: "video",
        background_source: "input_image",
      },
      requiresConfirmation: true,
      state: "pending",
    },
  });
  const motionOutput = engine.notebooks.createCell({
    type: "video",
    label: "Kittens dancing video",
    slot: { row: 4, column: 2 },
    inputs: {
      ...ownedInputs("kling-motion-control-output"),
      mediaRole: "generate-video-output",
      producerCellId: motion.id,
      state: "pending",
    },
  });
  const fixtureEdges = [
    engine.notebooks.createEdge({
      source: source.id,
      target: extract.id,
      targetInput: "segment",
    }),
    engine.notebooks.createEdge({
      source: extract.id,
      target: kittens.id,
      targetInput: "input",
    }),
    engine.notebooks.createEdge({
      source: kittens.id,
      target: kittenOutput.id,
      targetInput: "media",
    }),
    engine.notebooks.createEdge({
      source: kittenOutput.id,
      target: motion.id,
      targetInput: "image",
    }),
    engine.notebooks.createEdge({
      source: source.id,
      target: motion.id,
      targetInput: "video",
    }),
    engine.notebooks.createEdge({
      source: motion.id,
      target: motionOutput.id,
      targetInput: "media",
    }),
  ];
  const ensuredAt = new Date().toISOString();
  const document: NotebookDocument = {
    ...notebook,
    name: "Dancing Kittens",
    description: "Download a dance reference, extract its first frame, replace the dancers with kittens beside a freeway, then transfer the dance with Kling 3.0 Motion Control.",
    lifecycleState: "in-progress",
    cells: [
      ...preservedCells,
      source,
      extract,
      kittens,
      kittenOutput,
      motion,
      motionOutput,
    ],
    edges: [...preservedEdges, ...fixtureEdges],
    generationPlans: [],
    notebookRunPlans: [],
    execution: preservedExecution,
    fixture: {
      version: DANCING_FIXTURE_VERSION,
      owner: DANCING_FIXTURE_OWNER,
      ensuredAt,
      materializedAt: ensuredAt,
      noPaidCalls: true,
      sourceUrl: DANCING_SOURCE_URL,
      motionDurationSeconds: DANCING_MOTION_DURATION_SECONDS,
    },
  };
  document.execution = completedExecution(document, preservedExecution);
  const persisted = await writeNotebook(engine, document);
  persisted.execution = completedExecution(
    persisted,
    persisted.execution ?? preservedExecution,
  );
  return writeNotebook(engine, persisted);
}

export async function ensureDancingWorkflow(
  books: BookManager,
  options: DancingFixtureOptions = {},
): Promise<{
  status: "unchanged" | "migrated" | "created";
  notebookId: string;
  revision: string;
}> {
  await books.ready();
  let selected = books.getByName("dancing");
  let created = false;
  if (!selected.ok) {
    const createdBook = await books.create("dancing");
    if (!createdBook.ok) throw new Error(createdBook.error.message);
    selected = books.getByName("dancing");
    if (!selected.ok) throw new Error(selected.error.message);
    created = true;
  }
  const previousHead = selected.value.engine.head;
  const notebook = await seedDancingWorkflow(selected.value.engine, options);
  return {
    status: created
      ? "created"
      : selected.value.engine.head === previousHead
        ? "unchanged"
        : "migrated",
    notebookId: notebook.id,
    revision: selected.value.engine.head,
  };
}
