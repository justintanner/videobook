import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEngine,
  MVP_CONTRACT_VERSION,
  type Engine,
  type NotebookDocument,
} from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { FFMPEG } from "../../server/src/ffmpeg.js";
import {
  modelArgs,
  prepareNotebookGeneration,
  resolveNotebookGenerationTool,
  runNotebookCell,
} from "../../server/src/jobs/run-notebook.js";
import { DEFAULT_ANIMATION_TOOL } from "../../server/src/notebook-action-catalog.js";
import type { ToolDef } from "../../server/src/tools/tool-def.js";

const execFileAsync = promisify(execFile);

async function makeClip(path: string, seconds = 2): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", `testsrc=size=320x240:rate=24:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    path,
  ]);
}

describe("notebook runner dual-frame and assembly", () => {
  let rootDir: string | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.close();
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it("resolves generation tool from cell.tool before provider model id", () => {
    const tool = resolveNotebookGenerationTool({
      id: "019f0000-0000-7000-8000-000000000001",
      type: "video",
      title: "animate",
      position: { x: 0, y: 0 },
      model: "bytedance/seedance-2",
      tool: DEFAULT_ANIMATION_TOOL,
    });
    expect(tool).toBe(DEFAULT_ANIMATION_TOOL);
  });

  it("maps first_frame/last_frame upstreams into Seedance payload fields", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-runner-frames-"));
    engine = createEngine({ rootDir, initialBookSlug: "runner-frames" });
    await engine.ready;

    const first = await engine.artifacts.create({ kind: "image", name: "first frame" });
    const last = await engine.artifacts.create({ kind: "image", name: "last frame" });
    expect(first.ok && last.ok).toBe(true);
    if (!first.ok || !last.ok) return;
    await engine.files.write(first.value.artifactId, "original.jpg", Buffer.from("first"));
    await engine.files.write(last.value.artifactId, "original.jpg", Buffer.from("last"));

    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;

    const firstCell = engine.notebooks.createCell({
      type: "frame",
      title: "first",
      position: { x: 0, y: 0 },
      outputArtifactId: first.value.artifactId,
      inputs: { frameRole: "first" },
    });
    const lastCell = engine.notebooks.createCell({
      type: "frame",
      title: "last",
      position: { x: 100, y: 0 },
      outputArtifactId: last.value.artifactId,
      inputs: { frameRole: "last" },
    });
    const animate = engine.notebooks.createCell({
      type: "video",
      title: "animate",
      position: { x: 200, y: 0 },
      prompt: "Camera push in",
      provider: "kie",
      model: "bytedance/seedance-2",
      tool: DEFAULT_ANIMATION_TOOL,
      inputs: { requiresConfirmation: true },
    });
    const document: NotebookDocument = {
      ...notebook.value,
      cells: [firstCell, lastCell, animate],
      edges: [
        engine.notebooks.createEdge({
          source: firstCell.id,
          target: animate.id,
          targetInput: "first_frame",
        }),
        engine.notebooks.createEdge({
          source: lastCell.id,
          target: animate.id,
          targetInput: "last_frame",
        }),
      ],
    };
    await engine.notebooks.write(document);

    const definition = {
      name: DEFAULT_ANIMATION_TOOL,
      schema: {
        book_id: {},
        prompt: {},
        first_frame_slug: {},
        last_frame_slug: {},
      },
    } as unknown as ToolDef;

    const args = modelArgs(
      definition,
      document,
      animate,
      engine.book.get().bookId,
      engine,
    );
    expect(args.first_frame_slug).toBe(`@${first.value.slug}`);
    expect(args.last_frame_slug).toBe(`@${last.value.slug}`);

    const prepared = await prepareNotebookGeneration(
      engine,
      document,
      animate,
      engine.book.get().bookId,
    );
    expect(prepared.tool).toBe(DEFAULT_ANIMATION_TOOL);
    expect(prepared.input.first_frame_slug).toBe(`@${first.value.slug}`);
    expect(prepared.input.last_frame_slug).toBe(`@${last.value.slug}`);

    await expect(
      runNotebookCell(
        engine,
        engine.book.get().bookId,
        document.id,
        document,
        animate,
        { confirmPaid: false },
      ),
    ).rejects.toThrow(/requires confirmation/i);
  });

  it("places ordered clips on the primary sequence and pins sequenceRevision for export", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-runner-assemble-"));
    engine = createEngine({ rootDir, initialBookSlug: "runner-assemble" });
    await engine.ready;

    const clipPath = join(rootDir, "clip.mp4");
    await makeClip(clipPath, 1);
    const clipA = await engine.artifacts.create({ kind: "video", name: "clip a" });
    const clipB = await engine.artifacts.create({ kind: "video", name: "clip b" });
    expect(clipA.ok && clipB.ok).toBe(true);
    if (!clipA.ok || !clipB.ok) return;
    await engine.files.writeFromPath(clipA.value.artifactId, "original.mp4", clipPath);
    await engine.files.writeFromPath(clipB.value.artifactId, "original.mp4", clipPath);

    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;

    const videoA = engine.notebooks.createCell({
      type: "video",
      title: "a",
      position: { x: 0, y: 0 },
      outputArtifactId: clipA.value.artifactId,
    });
    const videoB = engine.notebooks.createCell({
      type: "video",
      title: "b",
      position: { x: 100, y: 0 },
      outputArtifactId: clipB.value.artifactId,
    });
    const sequence = engine.notebooks.createCell({
      type: "sequence",
      title: "assemble",
      position: { x: 200, y: 0 },
      provider: "local",
      operation: "assemble_sequence",
      tool: "engine_sequence",
    });
    const exp = engine.notebooks.createCell({
      type: "export",
      title: "export",
      position: { x: 300, y: 0 },
      provider: "local",
      operation: "export_master",
      tool: "ffmpeg",
    });
    const document: NotebookDocument = {
      ...notebook.value,
      cells: [videoA, videoB, sequence, exp],
      edges: [
        engine.notebooks.createEdge({
          source: videoA.id,
          target: sequence.id,
          targetInput: "clip:0",
        }),
        engine.notebooks.createEdge({
          source: videoB.id,
          target: sequence.id,
          targetInput: "clip:1",
        }),
        engine.notebooks.createEdge({
          source: sequence.id,
          target: exp.id,
          targetInput: "sequence",
        }),
      ],
    };
    await engine.notebooks.write(document);

    const assembled = await runNotebookCell(
      engine,
      engine.book.get().bookId,
      document.id,
      document,
      sequence,
    );
    const sequenceCell = assembled.document.cells.find((cell) => cell.id === sequence.id);
    expect(typeof sequenceCell?.inputs?.sequenceRevision).toBe("string");
    expect(String(sequenceCell?.inputs?.sequenceRevision).length).toBeGreaterThan(8);
    expect(Array.isArray(sequenceCell?.inputs?.clipArtifactIds)).toBe(true);
    expect(sequenceCell?.inputs?.clipArtifactIds).toEqual([
      clipA.value.artifactId,
      clipB.value.artifactId,
    ]);
    expect(engine.sequences.getPrimary().clips.length).toBeGreaterThanOrEqual(2);
    const pinnedRevision = String(sequenceCell?.inputs?.sequenceRevision);
    const sequenceId = String(sequenceCell?.inputs?.sequenceId
      ?? engine.sequences.getPrimary().sequenceId);

    // Unknown real-looking revision hash is not readable → stale.
    const unknownRevDoc: NotebookDocument = {
      ...assembled.document,
      cells: assembled.document.cells.map((cell) =>
        cell.id === sequence.id
          ? {
              ...cell,
              inputs: {
                ...(cell.inputs ?? {}),
                sequenceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              },
            }
          : cell),
    };
    await expect(
      runNotebookCell(
        engine,
        engine.book.get().bookId,
        document.id,
        unknownRevDoc,
        exp,
      ),
    ).rejects.toThrow(/stale|not readable/i);

    // Successful export while assembly still matches HEAD sequence.
    const exported = await runNotebookCell(
      engine,
      engine.book.get().bookId,
      document.id,
      assembled.document,
      exp,
    );
    expect(exported.outputArtifactId).toBeTruthy();
    const exportArtifact = engine.artifacts.get(exported.outputArtifactId);
    expect(exportArtifact.ok).toBe(true);

    // Mutate the live sequence after assembly — export must fail even though
    // the old pin still exists in Dolt history.
    const primary = engine.sequences.getPrimary();
    const videoTrack = primary.tracks.find((track) => track.kind === "video");
    expect(videoTrack).toBeTruthy();
    if (!videoTrack) return;
    const extraPath = join(rootDir, "extra.mp4");
    await makeClip(extraPath, 1);
    const extra = await engine.artifacts.create({ kind: "video", name: "extra clip" });
    expect(extra.ok).toBe(true);
    if (!extra.ok) return;
    await engine.files.writeFromPath(extra.value.artifactId, "original.mp4", extraPath);
    const extraManifest = await engine.files.manifest(extra.value.artifactId);
    expect(extraManifest.ok).toBe(true);
    if (!extraManifest.ok) return;
    const extraHash = extraManifest.value.files[0]?.objectHash;
    expect(extraHash).toBeTruthy();
    if (!extraHash) return;
    const intent = {
      intentVersion: MVP_CONTRACT_VERSION,
      commandId: uuidv7(),
      sequenceId,
      baseRevision: engine.head,
      actor: "stale-test",
      sourceSurface: "system" as const,
      confirmationPolicy: "reversible-single-step" as const,
      operations: [{
        kind: "insert-clip" as const,
        mode: "insert" as const,
        placement: {
          trackId: videoTrack.trackId,
          timelineStartFrame: 10_000,
          durationFrames: 24,
          source: {
            kind: "still" as const,
            artifactId: extra.value.artifactId,
            sourcePath: "original.mp4",
            objectHash: extraHash,
          },
        },
      }],
    };
    const preview = engine.edits.preview(intent);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const commit = await engine.edits.commit(intent, preview.value.previewHash);
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    expect(engine.head).not.toBe(pinnedRevision);
    expect(engine.sequences.getPrimary().clips.length)
      .toBeGreaterThan(assembled.document.cells.length > 0
        ? 2
        : 0);

    await expect(
      runNotebookCell(
        engine,
        engine.book.get().bookId,
        document.id,
        assembled.document,
        exp,
      ),
    ).rejects.toThrow(/stale|changed after assembly|diverged/i);
  }, 90_000);
});
