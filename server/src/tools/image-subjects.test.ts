import type { Client } from "@modelcontextprotocol/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Engine } from "videobook-engine";
import {
  IMAGE_SUBJECT_MAP_VERSION,
  applyGrokSegmentsToSubjects,
  exactEditMaskIndexes,
  grokMaskIndex,
  imageSubjectMapRecordSchema,
  parseGrokSegmentMapResult,
  persistSeedreamSubjectLayers,
  readImageSubjectMapRecord,
  resolveImageSubjectSource,
  subjectAnalysisProviderFailureMessage,
  writeCurrentImageSubjectAnalysisRecord,
  writeImageSubjectMapRecord,
  type ImageSubjectMapReadyV1,
} from "../image-subject-map.js";
import {
  grokImagineImage2EditRequest,
  persistExtraResultImages,
  imageSubjectAnalysisDeadline,
  imageSubjectEditRoute,
  parseSeedreamLayerResult,
  readGrokImagineImage2SourceTaskId,
  readStoredImageSubjectEditTask,
  reconcileImageSubjectJobFailures,
  regionReplacementPrompt,
  seedreamLayerDecompositionRequest,
  seedreamLayerDecompositionSize,
  SEEDREAM_LAYER_FALLBACK_PROMPT,
  SEEDREAM_TOO_COMPLEX_PATTERN,
  seedreamProImageUrlCapacityError,
  seedreamRegionReplacementRequest,
  SEEDREAM_PRO_I2I_MAX_IMAGE_URLS,
} from "../jobs/image-subjects.js";
import { createEngineForTest } from "../engine.js";
import {
  enqueueOptions,
  queue,
  recoverInterruptedSubjectEditArtifact,
  waitForJob,
} from "../queue.js";
import { createTestClient } from "../test-client.js";
import {
  imageSubjectAnalysisJobIsActive,
  imageSubjectAnalysisJobId,
  imageSubjectAnalysisResumeTaskId,
  reuseImageSubjectAnalysis,
} from "./image-subjects.js";

type TextContent = Array<{ type: string; text: string }>;

function resultJson(result: { content?: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as TextContent)[0]!.text) as Record<string, unknown>;
}

async function solidPng(
  width: number,
  height: number,
  background: { r: number; g: number; b: number; alpha?: number },
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: background.alpha === undefined ? 3 : 4,
      background,
    },
  }).png().toBuffer();
}

async function canvasLayer(
  width: number,
  height: number,
  placement: { left: number; top: number; width: number; height: number },
  color: { r: number; g: number; b: number },
): Promise<Buffer> {
  const subject = await solidPng(placement.width, placement.height, {
    ...color,
    alpha: 1,
  });
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: subject, left: placement.left, top: placement.top }])
    .png()
    .toBuffer();
}

async function pixel(
  buffer: Buffer,
  x: number,
  y: number,
): Promise<[number, number, number, number]> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [
    data[offset]!,
    data[offset + 1]!,
    data[offset + 2]!,
    data[offset + 3]!,
  ];
}

function asDataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

describe("image subject tools", () => {
  let tempDir: string;
  let client: Client;
  let engine: Engine;
  let bookId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-image-subjects-"));
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    await engine.ready;
    bookId = engine.book.get().bookId;
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createSource(): Promise<{
    artifactId: string;
    objectHash: string;
    map: ImageSubjectMapReadyV1;
    sourceCellId: string;
    notebookId: string;
    original: Buffer;
  }> {
    const base = await solidPng(100, 100, { r: 20, g: 40, b: 180 });
    const person = await canvasLayer(
      100,
      100,
      { left: 10, top: 10, width: 20, height: 30 },
      { r: 230, g: 20, b: 20 },
    );
    const object = await canvasLayer(
      100,
      100,
      { left: 60, top: 60, width: 25, height: 20 },
      { r: 20, g: 220, b: 40 },
    );
    const original = await sharp(base)
      .composite([{ input: person }, { input: object }])
      .png()
      .toBuffer();
    const artifact = await engine.artifacts.create({ kind: "image", label: "Subjects" });
    if (!artifact.ok) throw new Error(artifact.error.message);
    const artifactId = artifact.value.artifactId;
    const sourceWrite = await engine.files.write(artifactId, "original.png", original);
    if (!sourceWrite.ok) throw new Error(sourceWrite.error.message);
    const originalMetadata = await engine.metadata.artifacts.write(
      artifactId,
      "original",
      { origin: "test", width: 100, height: 100 },
    );
    if (!originalMetadata.ok) throw new Error(originalMetadata.error.message);
    const source = await resolveImageSubjectSource(engine, artifactId);
    const root = `.image-subjects/${source.objectHash}/test-analysis`;
    const baseFile = `${root}/base.png`;
    const personFile = `${root}/person.png`;
    const objectFile = `${root}/object.png`;
    const writes = await Promise.all([
      engine.files.write(artifactId, baseFile, base),
      engine.files.write(artifactId, personFile, person),
      engine.files.write(artifactId, objectFile, object),
    ]);
    for (const write of writes) {
      if (!write.ok) throw new Error(write.error.message);
    }
    const map: ImageSubjectMapReadyV1 = {
      version: IMAGE_SUBJECT_MAP_VERSION,
      status: "ready",
      artifactId,
      objectHash: source.objectHash,
      width: 100,
      height: 100,
      jobId: "analysis-job",
      provider: "kie",
      model: "seedream/5-pro-layer-decomposition",
      analysisId: "test-analysis",
      analyzedAt: new Date().toISOString(),
      taskId: "task-1",
      baseFile,
      subjects: [
        {
          id: "person",
          label: "Person",
          description: "Standing person",
          color: "#ef4444",
          normalizedBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
          layerFile: personFile,
          thumbnailFile: personFile,
          zIndex: 1,
          exactEdit: false,
        },
        {
          id: "object",
          label: "Green object",
          description: "Object on the right",
          color: "#3b82f6",
          normalizedBox: { x: 0.6, y: 0.6, width: 0.25, height: 0.2 },
          layerFile: objectFile,
          thumbnailFile: objectFile,
          zIndex: 2,
          exactEdit: false,
        },
      ],
    };
    await writeImageSubjectMapRecord(engine, map);
    let notebook = engine.notebooks.list()[0];
    if (!notebook) {
      const created = await engine.notebooks.create("Main");
      if (!created.ok) throw new Error(created.error.message);
      notebook = created.value;
    }
    const read = engine.notebooks.read(notebook.id);
    if (!read.ok) throw new Error(read.error.message);
    const sourceCell = engine.notebooks.createCell({
      type: "image",
      label: "Subjects",
      slot: { row: 0, column: 0 },
      outputArtifactId: artifactId,
      inputs: { state: "completed", objectHash: source.objectHash },
    });
    const written = await engine.notebooks.write({
      ...read.value,
      cells: [...read.value.cells, sourceCell],
    });
    if (!written.ok) throw new Error(written.error.message);
    return {
      artifactId,
      objectHash: source.objectHash,
      map,
      sourceCellId: sourceCell.id,
      notebookId: notebook.id,
      original,
    };
  }

  it("parses Seedream layers and normalizes documented 0-1000 boxes", () => {
    const result = parseSeedreamLayerResult(JSON.stringify({
      layers_data: [
        { url: "https://example.test/base.png", z_index: 0 },
        {
          url: "https://example.test/person.png",
          z_index: 2,
          name: "Person",
          description: "A person",
          bounding_box: { normalized: [100, 200, 500, 800] },
        },
      ],
    }));
    expect(result.baseUrl).toBe("https://example.test/base.png");
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]).toMatchObject({
      url: "https://example.test/person.png",
      zIndex: 2,
      name: "Person",
      description: "A person",
    });
    expect(result.layers[0]!.normalizedBox?.x).toBeCloseTo(0.1);
    expect(result.layers[0]!.normalizedBox?.y).toBeCloseTo(0.2);
    expect(result.layers[0]!.normalizedBox?.width).toBeCloseTo(0.4);
    expect(result.layers[0]!.normalizedBox?.height).toBeCloseTo(0.6);
    expect(() => parseSeedreamLayerResult(JSON.stringify({
      resultObject: {
        layers_data: [{
          url: "https://example.test/person.png",
          z_index: 1,
          name: "Person",
          bounding_box: { normalized: [100, 200, 500, 800] },
        }],
      },
    }))).toThrow("no identifiable base layer");
  });

  it("preserves zero-based Grok segment indexes for exact edit", () => {
    expect(grokMaskIndex(0)).toBe(0);
    expect(grokMaskIndex(1)).toBe(1);
    expect(grokMaskIndex(-1)).toBeUndefined();
    const segments = parseGrokSegmentMapResult(JSON.stringify({
      resultObject: {
        segments: [
          { index: 0, name: "Person", normalizedBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 } },
          { index: 1, name: "Green object", normalizedBox: { x: 0.6, y: 0.6, width: 0.25, height: 0.2 } },
          { index: 2, name: "Hat", normalizedBox: { x: 0.2, y: 0.05, width: 0.1, height: 0.1 } },
        ],
      },
    }));
    expect(segments.map((segment) => segment.index)).toEqual([0, 1, 2]);
    const subjects = applyGrokSegmentsToSubjects([
      {
        id: "person",
        label: "Person",
        description: "Standing person",
        color: "#ef4444",
        normalizedBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
        layerFile: "person.png",
        thumbnailFile: "person.png",
        zIndex: 1,
        exactEdit: false,
      },
      {
        id: "object",
        label: "Green object",
        description: "Object on the right",
        color: "#3b82f6",
        normalizedBox: { x: 0.6, y: 0.6, width: 0.25, height: 0.2 },
        layerFile: "object.png",
        thumbnailFile: "object.png",
        zIndex: 2,
        exactEdit: false,
      },
    ], segments);
    expect(subjects).toEqual([
      expect.objectContaining({ id: "person", exactEdit: true, maskIndex: 0 }),
      expect.objectContaining({ id: "object", exactEdit: true, maskIndex: 1 }),
    ]);
    expect(exactEditMaskIndexes(subjects, ["person", "object"])).toEqual([0, 1]);
    expect(exactEditMaskIndexes(
      subjects.map((subject) => ({ ...subject, exactEdit: true, maskIndex: undefined })),
      ["person"],
    )).toBeNull();
    expect(grokImagineImage2EditRequest("src-task", "Give the cat a bow", [0, 1, 2]).input)
      .toEqual({
        prompt: "Give the cat a bow",
        task_id: "src-task",
        mask_indexs: [0, 1, 2],
      });
    expect(grokImagineImage2EditRequest("src-task", "no masks", [0]).input)
      .toEqual({
        prompt: "no masks",
        task_id: "src-task",
        mask_indexs: [0],
      });
    expect(() => grokImagineImage2EditRequest("src-task", "no masks", [-1]))
      .toThrow("nonnegative mask indexes");
  });

  it("routes selected exact_edit subjects to Grok image-edit and otherwise Seedream", async () => {
    const source = await createSource();
    expect(imageSubjectEditRoute(source.map, ["person"])).toBe("semantic");
    const exactMap: ImageSubjectMapReadyV1 = {
      ...source.map,
      grokSourceTaskId: "grok-source-task",
      subjects: applyGrokSegmentsToSubjects(source.map.subjects, [
        { index: 0, name: "background" },
        { index: 1, name: "Person" },
      ]),
    };
    await writeImageSubjectMapRecord(engine, exactMap);
    const stored = await readImageSubjectMapRecord(engine, source.artifactId);
    expect(stored?.status).toBe("ready");
    if (stored?.status !== "ready") return;
    expect(imageSubjectEditRoute(stored, ["person"])).toBe("exact");
    expect(imageSubjectEditRoute(stored, ["object"])).toBe("semantic");
    const presented = await client.callTool({
      name: "get_image_subject_map",
      arguments: {
        book_id: bookId,
        artifact_id: source.artifactId,
        object_hash: source.objectHash,
      },
    });
    expect(presented.isError).not.toBe(true);
    const parsed = resultJson(presented) as {
      subjects: Array<{ id: string; capabilities: { exact_edit: boolean } }>;
    };
    expect(parsed.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "person",
        capabilities: { remove: true, exact_edit: true },
      }),
      expect.objectContaining({
        id: "object",
        capabilities: { remove: true, exact_edit: false },
      }),
    ]));
    await engine.metadata.artifacts.write(source.artifactId, "generation-payload", {
      model: "grok-imagine-image-2-0/text-to-image",
      input: { prompt: "A cat", aspect_ratio: "1:1" },
    });
    await engine.metadata.artifacts.write(source.artifactId, "kie-task-id", {
      taskId: "grok-source-task",
    });
    await expect(readGrokImagineImage2SourceTaskId(engine, source.artifactId))
      .resolves.toBe("grok-source-task");
    await engine.metadata.artifacts.write(source.artifactId, "generation-payload", {
      model: "seedream/5-pro-image-to-image",
      input: { prompt: "not grok" },
    });
    await expect(readGrokImagineImage2SourceTaskId(engine, source.artifactId))
      .resolves.toBeNull();
    const extraA = await solidPng(8, 8, { r: 1, g: 2, b: 3 });
    const extraB = await solidPng(8, 8, { r: 4, g: 5, b: 6 });
    await persistExtraResultImages(engine, source.artifactId, [extraA, extraB]);
    const second = await engine.files.read(source.artifactId, "result-2.png");
    const third = await engine.files.read(source.artifactId, "result-3.png");
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
    if (second.ok && third.ok) {
      expect(Buffer.from(second.value).equals(extraA)).toBe(true);
      expect(Buffer.from(third.value).equals(extraB)).toBe(true);
    }
  });

  it("uses the JPEG layer request and a persisted absolute analysis deadline", () => {
    const startedAt = "2026-08-17T07:00:00.000Z";
    const request = seedreamLayerDecompositionRequest(
      "https://example.test/source.jpg",
      1920,
      1080,
    );
    expect(request.input.output_format).toBe("jpeg");
    expect(imageSubjectAnalysisDeadline(startedAt)).toBe(
      Date.parse(startedAt) + 25 * 60_000,
    );
    expect(subjectAnalysisProviderFailureMessage("Internal Error")).toBe(
      "Subject analysis provider failed: Internal Error. Retry in a moment.",
    );
  });

  it("retries with an element-selection prompt on Seedream too-complex rejections", () => {
    // Exact failMsg observed from Seedream (surfaced via
    // subjectAnalysisProviderFailureMessage) for busy scenes under automatic
    // element detection.
    const providerMessage = subjectAnalysisProviderFailureMessage(
      "The parameter `image` specified in the request are not valid: "
        + "the image content is too complex to decompose into layers.",
      "400",
    );
    expect(SEEDREAM_TOO_COMPLEX_PATTERN.test(providerMessage)).toBe(true);
    expect(SEEDREAM_TOO_COMPLEX_PATTERN.test(
      subjectAnalysisProviderFailureMessage("Internal Error"),
    )).toBe(false);

    const automatic = seedreamLayerDecompositionRequest(
      "https://example.test/source.jpg",
      1920,
      1080,
    );
    expect(automatic.input.prompt).toBeUndefined();
    const constrained = seedreamLayerDecompositionRequest(
      "https://example.test/source.jpg",
      1920,
      1080,
      SEEDREAM_LAYER_FALLBACK_PROMPT,
    );
    expect(constrained.input.prompt).toBe(SEEDREAM_LAYER_FALLBACK_PROMPT);
    expect(constrained.input.size).toBe("2K");
  });

  it("selects an explicit paygate-priced size tier from source dimensions", () => {
    // "auto" has no paygate rate; the request must always carry a priced tier.
    expect(seedreamLayerDecompositionSize(1024, 768)).toBe("1K");
    expect(seedreamLayerDecompositionSize(1280, 1280)).toBe("1K");
    expect(seedreamLayerDecompositionSize(768, 1536)).toBe("1.5K");
    expect(seedreamLayerDecompositionSize(1792, 1024)).toBe("1.5K");
    expect(seedreamLayerDecompositionSize(1920, 1080)).toBe("2K");
    expect(seedreamLayerDecompositionSize(4096, 4096)).toBe("2K");
    expect(seedreamLayerDecompositionRequest(
      "https://example.test/source.jpg",
      640,
      480,
    ).input.size).toBe("1K");
  });

  it("rejects cropped layers that have no valid placement box", async () => {
    const artifact = await engine.artifacts.create({ kind: "image", label: "Malformed" });
    if (!artifact.ok) throw new Error(artifact.error.message);
    const sourceImage = await solidPng(100, 100, { r: 0, g: 0, b: 0 });
    const write = await engine.files.write(artifact.value.artifactId, "original.png", sourceImage);
    if (!write.ok) throw new Error(write.error.message);
    const source = await resolveImageSubjectSource(engine, artifact.value.artifactId);
    const croppedLayer = await solidPng(20, 30, { r: 255, g: 0, b: 0, alpha: 1 });
    await expect(persistSeedreamSubjectLayers(engine, source, {
      jobId: "malformed-job",
      taskId: "malformed-task",
      baseUrl: asDataUrl(sourceImage),
      layers: [{ url: asDataUrl(croppedLayer), zIndex: 1, name: "Person" }],
    })).rejects.toThrow("have no valid bounding box");

    const malformedBox = parseSeedreamLayerResult(JSON.stringify({
      layers_data: [
        { url: "https://example.test/base.png", z_index: 4 },
        {
          url: "https://example.test/person.png",
          z_index: 5,
          name: "Person",
          bounding_box: { normalized: [-10, 0, 400, 900] },
        },
      ],
    }));
    expect(malformedBox.layers[0]?.normalizedBox).toBeUndefined();
    const ambiguousBox = parseSeedreamLayerResult(JSON.stringify({
      layers_data: [
        { url: "https://example.test/base.png", z_index: 0 },
        {
          url: "https://example.test/person.png",
          z_index: 1,
          name: "Person",
          bounding_box: { normalized: [1.1, 0, 400, 900] },
        },
      ],
    }));
    expect(ambiguousBox.layers[0]?.normalizedBox).toBeUndefined();

    const transparent = await solidPng(100, 100, {
      r: 0,
      g: 0,
      b: 0,
      alpha: 0,
    });
    await expect(persistSeedreamSubjectLayers(engine, source, {
      jobId: "transparent-job",
      taskId: "transparent-task",
      baseUrl: asDataUrl(sourceImage),
      layers: [{ url: asDataUrl(transparent), zIndex: 1, name: "Nothing" }],
    })).rejects.toThrow("all-transparent subject layer");
  });

  it("rejects duplicate subject identifiers and z-indexes", async () => {
    const source = await createSource();
    const duplicate = {
      ...source.map,
      subjects: [
        source.map.subjects[0]!,
        {
          ...source.map.subjects[1]!,
          id: source.map.subjects[0]!.id,
          zIndex: source.map.subjects[0]!.zIndex,
        },
      ],
    };
    const parsed = imageSubjectMapRecordSchema.safeParse(duplicate);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        expect.stringContaining("duplicate subject id"),
        expect.stringContaining("duplicate subject z-index"),
      ]));
    }
  });

  it("reuses cached and in-flight analysis but force-retries a ready or failed map", async () => {
    const source = await createSource();
    expect(reuseImageSubjectAnalysis(source.map, source.objectHash, false, false)).toBe(true);
    expect(reuseImageSubjectAnalysis(source.map, source.objectHash, true, false)).toBe(false);
    const analyzing = {
      version: 1 as const,
      status: "analyzing" as const,
      artifactId: source.artifactId,
      objectHash: source.objectHash,
      width: 100,
      height: 100,
      jobId: "running-job",
      startedAt: new Date().toISOString(),
      taskId: "running-provider-task",
    };
    expect(reuseImageSubjectAnalysis(
      analyzing,
      source.objectHash,
      true,
      false,
    )).toBe(false);
    expect(imageSubjectAnalysisResumeTaskId(
      analyzing,
      source.objectHash,
      false,
    )).toBeUndefined();
    expect(imageSubjectAnalysisResumeTaskId(
      analyzing,
      "changed-object-hash",
      true,
    )).toBeUndefined();
    expect(imageSubjectAnalysisResumeTaskId(
      analyzing,
      source.objectHash,
      true,
    )).toBe(
      "running-provider-task",
    );
    engine.jobs.queue.enqueue({
      type: "analyze_image_subjects",
      initialState: "running",
      dedupeKey: "running-analysis-regression",
      payload: {
        type: "analyze_image_subjects",
        sourceArtifactId: source.artifactId,
        sourceObjectHash: source.objectHash,
        bookId,
        jobId: analyzing.jobId,
      },
    });
    expect(imageSubjectAnalysisJobIsActive(engine, analyzing.jobId)).toBe(true);
    expect(reuseImageSubjectAnalysis(
      analyzing,
      source.objectHash,
      true,
      true,
    )).toBe(true);
    expect(reuseImageSubjectAnalysis({
      version: 1,
      status: "failed",
      artifactId: source.artifactId,
      objectHash: source.objectHash,
      width: 100,
      height: 100,
      jobId: "failed-job",
      error: "provider failed",
      failedAt: new Date().toISOString(),
    }, source.objectHash, false, false)).toBe(false);
    const first = imageSubjectAnalysisJobId(
      source.artifactId,
      source.objectHash,
      null,
      false,
    );
    expect(imageSubjectAnalysisJobId(
      source.artifactId,
      source.objectHash,
      null,
      false,
    )).toBe(first);
    const retry = imageSubjectAnalysisJobId(
      source.artifactId,
      source.objectHash,
      first,
      true,
    );
    expect(retry).not.toBe(first);
    expect(imageSubjectAnalysisJobId(
      source.artifactId,
      source.objectHash,
      first,
      true,
    )).toBe(retry);
  });

  it("exposes the persisted start time while the matching analysis job is active", async () => {
    const source = await createSource();
    const jobId = "active-subject-analysis";
    const startedAt = "2026-08-17T07:10:00.000Z";
    await writeImageSubjectMapRecord(engine, {
      version: IMAGE_SUBJECT_MAP_VERSION,
      status: "analyzing",
      artifactId: source.artifactId,
      objectHash: source.objectHash,
      width: 100,
      height: 100,
      jobId,
      startedAt,
    });
    engine.jobs.queue.enqueue({
      type: "analyze_image_subjects",
      initialState: "running",
      dedupeKey: jobId,
      payload: {
        type: "analyze_image_subjects",
        sourceArtifactId: source.artifactId,
        sourceObjectHash: source.objectHash,
        bookId,
        jobId,
      },
    });

    const result = await client.callTool({
      name: "get_image_subject_map",
      arguments: {
        book_id: bookId,
        artifact_id: source.artifactId,
        object_hash: source.objectHash,
      },
    });
    expect(resultJson(result)).toMatchObject({
      status: "analyzing",
      job_id: jobId,
      started_at: startedAt,
    });
  });

  it("projects orphaned and terminal analysis records without mutating metadata", async () => {
    const source = await createSource();
    const getMap = async () => resultJson(await client.callTool({
      name: "get_image_subject_map",
      arguments: {
        book_id: bookId,
        artifact_id: source.artifactId,
        object_hash: source.objectHash,
      },
    }));
    const marker = (jobId: string) => ({
      version: IMAGE_SUBJECT_MAP_VERSION,
      status: "analyzing" as const,
      artifactId: source.artifactId,
      objectHash: source.objectHash,
      width: 100,
      height: 100,
      jobId,
      startedAt: "2026-08-17T07:20:00.000Z",
    });

    await writeImageSubjectMapRecord(engine, marker("orphan-analysis"));
    expect(await getMap()).toMatchObject({
      status: "failed",
      error: "Subject analysis is no longer active. Retry the analysis.",
    });
    expect(await readImageSubjectMapRecord(engine, source.artifactId)).toMatchObject({
      status: "analyzing",
      jobId: "orphan-analysis",
    });

    const doneJobId = "done-without-map-analysis";
    await writeImageSubjectMapRecord(engine, marker(doneJobId));
    const done = engine.jobs.queue.enqueue({
      type: "analyze_image_subjects",
      initialState: "running",
      dedupeKey: doneJobId,
      payload: {
        type: "analyze_image_subjects",
        sourceArtifactId: source.artifactId,
        sourceObjectHash: source.objectHash,
        bookId,
        jobId: doneJobId,
      },
    });
    await engine.jobs.queue.complete(done.job.id, { result: { success: true } });
    expect(await getMap()).toMatchObject({
      status: "failed",
      error: "Subject analysis completed without publishing subjects. Retry the analysis.",
    });
    expect(await reconcileImageSubjectJobFailures(engine, bookId)).toEqual({
      analysesFailed: 1,
      editsFailed: 0,
    });
    expect(await readImageSubjectMapRecord(engine, source.artifactId)).toMatchObject({
      status: "failed",
      jobId: doneJobId,
      error: "Subject analysis completed without publishing subjects. Retry the analysis.",
    });

    const failedJobId = "failed-provider-analysis";
    await writeImageSubjectMapRecord(engine, marker(failedJobId));
    const failed = engine.jobs.queue.enqueue({
      type: "analyze_image_subjects",
      initialState: "running",
      dedupeKey: failedJobId,
      maxAttempts: 1,
      payload: {
        type: "analyze_image_subjects",
        sourceArtifactId: source.artifactId,
        sourceObjectHash: source.objectHash,
        bookId,
        jobId: failedJobId,
      },
    });
    await engine.jobs.queue.fail(failed.job.id, {
      error: { message: "Internal Error" },
      allowRetry: false,
    });
    expect(await getMap()).toMatchObject({
      status: "failed",
      error: "Subject analysis provider failed: Internal Error. Retry in a moment.",
    });

    await writeImageSubjectMapRecord(engine, {
      version: IMAGE_SUBJECT_MAP_VERSION,
      status: "failed",
      artifactId: source.artifactId,
      objectHash: source.objectHash,
      width: 100,
      height: 100,
      jobId: "cached-provider-failure",
      error: "Internal Error",
      failedAt: new Date().toISOString(),
    });
    expect(await getMap()).toMatchObject({
      status: "failed",
      error: "Subject analysis provider failed: Internal Error. Retry in a moment.",
    });
    expect(await readImageSubjectMapRecord(engine, source.artifactId)).toMatchObject({
      status: "failed",
      error: "Internal Error",
    });
  });

  it("prevents stale analysis handlers from publishing over a newer marker", async () => {
    const source = await createSource();
    const staleJobId = "stale-analysis";
    const currentJobId = "current-analysis";
    await writeImageSubjectMapRecord(engine, {
      version: IMAGE_SUBJECT_MAP_VERSION,
      status: "analyzing",
      artifactId: source.artifactId,
      objectHash: source.objectHash,
      width: 100,
      height: 100,
      jobId: staleJobId,
      startedAt: new Date().toISOString(),
    });
    const staleReady = writeCurrentImageSubjectAnalysisRecord(engine, {
      ...source.map,
      jobId: staleJobId,
    });
    const newerMarker = writeImageSubjectMapRecord(engine, {
      version: IMAGE_SUBJECT_MAP_VERSION,
      status: "analyzing",
      artifactId: source.artifactId,
      objectHash: source.objectHash,
      width: 100,
      height: 100,
      jobId: currentJobId,
      startedAt: new Date().toISOString(),
    });
    await expect(staleReady).resolves.toBe(true);
    await newerMarker;
    expect(await writeCurrentImageSubjectAnalysisRecord(engine, {
      version: IMAGE_SUBJECT_MAP_VERSION,
      status: "failed",
      artifactId: source.artifactId,
      objectHash: source.objectHash,
      width: 100,
      height: 100,
      jobId: staleJobId,
      error: "stale failure",
      failedAt: new Date().toISOString(),
    })).toBe(false);
    expect(await readImageSubjectMapRecord(engine, source.artifactId)).toMatchObject({
      status: "analyzing",
      jobId: currentJobId,
    });
  });

  it("marks lease-expired analysis records failed so a deterministic retry can start", async () => {
    const source = await createSource();
    const jobId = "expired-subject-analysis";
    await writeImageSubjectMapRecord(engine, {
      version: IMAGE_SUBJECT_MAP_VERSION,
      status: "analyzing",
      artifactId: source.artifactId,
      objectHash: source.objectHash,
      width: 100,
      height: 100,
      jobId,
      startedAt: new Date().toISOString(),
      taskId: "persisted-analysis-task",
    });
    const enqueued = engine.jobs.queue.enqueue({
      type: "analyze_image_subjects",
      dedupeKey: jobId,
      maxAttempts: 1,
      payload: {
        type: "analyze_image_subjects",
        sourceArtifactId: source.artifactId,
        sourceObjectHash: source.objectHash,
        bookId,
        jobId,
      },
    });
    const claimed = engine.jobs.queue.dequeue(process.pid, 1);
    expect(claimed?.id).toBe(enqueued.job.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await engine.jobs.queue.reap();

    const projected = resultJson(await client.callTool({
      name: "get_image_subject_map",
      arguments: {
        book_id: bookId,
        artifact_id: source.artifactId,
        object_hash: source.objectHash,
      },
    }));
    expect(projected).toMatchObject({
      status: "failed",
      error: "Job lease expired. Retry the analysis.",
    });

    const reconciled = await reconcileImageSubjectJobFailures(engine, bookId);
    expect(reconciled).toEqual({ analysesFailed: 1, editsFailed: 0 });
    const failed = await engine.metadata.artifacts.read<Record<string, unknown>>(
      source.artifactId,
      "image-subject-map.v1",
    );
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value).toMatchObject({
      status: "failed",
      jobId,
      taskId: "persisted-analysis-task",
      error: "Job lease expired",
    });
    const retry = imageSubjectAnalysisJobId(
      source.artifactId,
      source.objectHash,
      jobId,
      true,
    );
    expect(retry).not.toBe(jobId);
    expect(retry).toBe(imageSubjectAnalysisJobId(
      source.artifactId,
      source.objectHash,
      jobId,
      true,
    ));
  });

  it("persists semantic edit tasks while analysis jobs do not replay", async () => {
    const output = await engine.artifacts.create({ kind: "image", label: "Replay" });
    if (!output.ok) throw new Error(output.error.message);
    const request = {
      model: "seedream/5-pro-image-to-image" as const,
      input: {
        image_urls: ["https://example.test/source.png"],
        prompt: "Edit the selected person",
        aspect_ratio: "1:1" as const,
        quality: "basic" as const,
        output_format: "png" as const,
        nsfw_checker: false,
      },
    };
    const requestWrite = await engine.metadata.artifacts.write(
      output.value.artifactId,
      "generation-payload",
      request,
    );
    if (!requestWrite.ok) throw new Error(requestWrite.error.message);
    const taskWrite = await engine.metadata.artifacts.write(
      output.value.artifactId,
      "kie-task-id",
      { taskId: "billed-kie-task" },
    );
    if (!taskWrite.ok) throw new Error(taskWrite.error.message);

    await expect(readStoredImageSubjectEditTask(
      engine,
      output.value.artifactId,
    )).resolves.toEqual({ request, taskId: "billed-kie-task" });
    expect(enqueueOptions("analysis-replay", {
      type: "analyze_image_subjects",
      bookId,
    }).maxAttempts).toBe(1);
    expect(enqueueOptions("edit-replay", {
      type: "generate_image_subject_edit",
      bookId,
      imageAssetId: output.value.artifactId,
    }).maxAttempts).toBe(2);
    const interrupted = engine.jobs.artifactWork.begin(output.value.artifactId, {
      kind: "generate",
      ownerKind: "job",
      durationMs: 15 * 60_000,
    });
    expect(interrupted).not.toBeNull();
    expect(engine.jobs.artifactWork.begin(output.value.artifactId, {
      kind: "generate",
      ownerKind: "job",
      durationMs: 15 * 60_000,
    })).toBeNull();
    await recoverInterruptedSubjectEditArtifact(engine, output.value.artifactId);
    const reacquired = engine.jobs.artifactWork.begin(output.value.artifactId, {
      kind: "generate",
      ownerKind: "job",
      durationMs: 15 * 60_000,
    });
    expect(reacquired).not.toBeNull();
    if (reacquired) {
      expect(engine.jobs.artifactWork.complete(
        output.value.artifactId,
        reacquired.ownerId,
      )).toBe(true);
    }
  });

  it("terminalizes notebook edit cells when a replayable job exhausts its lease", async () => {
    const source = await createSource();
    const output = await engine.artifacts.create({ kind: "image", label: "Interrupted edit" });
    if (!output.ok) throw new Error(output.error.message);
    const jobId = "expired-subject-edit";
    const notebook = engine.notebooks.read(source.notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const producer = engine.notebooks.createCell({
      type: "generate_image",
      label: "Interrupted edit",
      slot: { row: 1, column: 0 },
      prompt: "Edit person",
      provider: "kie",
      model: "seedream/5-pro-image-to-image",
      operation: "image_to_image",
      tool: "edit_image_subjects",
      inputs: { state: "awaiting-output" },
    });
    const outputCell = engine.notebooks.createCell({
      type: "image",
      label: "Interrupted output",
      slot: { row: 1, column: 1 },
      outputArtifactId: output.value.artifactId,
      inputs: { state: "awaiting-output" },
    });
    const notebookWrite = await engine.notebooks.write({
      ...notebook.value,
      cells: [...notebook.value.cells, producer, outputCell],
      execution: {
        ...(notebook.value.execution ?? {}),
        [producer.id]: {
          status: "awaiting_provider",
          outputArtifactId: output.value.artifactId,
          providerArtifactId: output.value.artifactId,
          runId: jobId,
          updatedAt: new Date().toISOString(),
          tool: "edit_image_subjects",
        },
        [outputCell.id]: {
          status: "awaiting_provider",
          outputArtifactId: output.value.artifactId,
          runId: jobId,
          updatedAt: new Date().toISOString(),
          tool: "edit_image_subjects",
        },
      },
    });
    if (!notebookWrite.ok) throw new Error(notebookWrite.error.message);
    const generation = await engine.generations.record({
      notebookId: source.notebookId,
      cellId: producer.id,
      outputCellId: outputCell.id,
      runId: jobId,
      status: "awaiting_provider",
      tool: "edit_image_subjects",
      provider: "kie",
      model: "seedream/5-pro-image-to-image",
      prompt: "Edit person",
      providerArtifactId: output.value.artifactId,
    });
    if (!generation.ok) throw new Error(generation.error.message);
    const payload = {
      type: "generate_image_subject_edit",
      imageAssetId: output.value.artifactId,
      sourceArtifactId: source.artifactId,
      sourceObjectHash: source.objectHash,
      subjectIds: ["person"],
      operation: "edit",
      prompt: "Edit person",
      bookId,
      notebookId: source.notebookId,
      producerCellId: producer.id,
      outputCellId: outputCell.id,
      generationId: generation.value.generationId,
      jobId,
    };
    const enqueued = engine.jobs.queue.enqueue({
      type: "generate_image_subject_edit",
      artifactId: output.value.artifactId,
      dedupeKey: jobId,
      maxAttempts: 1,
      payload,
    });
    const claimed = engine.jobs.queue.dequeue(process.pid, 1);
    expect(claimed?.id).toBe(enqueued.job.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await engine.jobs.queue.reap();

    const reconciled = await reconcileImageSubjectJobFailures(engine, bookId);
    expect(reconciled).toEqual({ analysesFailed: 0, editsFailed: 1 });
    const terminal = engine.notebooks.read(source.notebookId);
    if (!terminal.ok) throw new Error(terminal.error.message);
    expect(terminal.value.execution?.[producer.id]).toMatchObject({
      status: "error",
      runId: jobId,
      error: "Job lease expired",
    });
    expect(terminal.value.execution?.[outputCell.id]).toMatchObject({
      status: "error",
      runId: jobId,
      error: "Job lease expired",
    });
    expect(terminal.value.cells.find((cell) => cell.id === outputCell.id)?.inputs)
      .toMatchObject({ state: "error", error: "Job lease expired" });
    const generations = engine.generations.listForCell(source.notebookId, producer.id);
    if (!generations.ok) throw new Error(generations.error.message);
    expect(generations.value[0]).toMatchObject({
      status: "failed",
      error: "Job lease expired",
    });
    const awaiting = await engine.generations.update(
      generation.value.generationId,
      { status: "awaiting_provider", error: null },
    );
    if (!awaiting.ok) throw new Error(awaiting.error.message);
    expect(awaiting.value.status).toBe("awaiting_provider");
    expect(awaiting.value).not.toHaveProperty("error");

    await queue.enqueue(jobId, {
      ...payload,
      operation: "remove",
      prompt: "Remove person",
    });
    await waitForJob(jobId, 30_000);
    const completed = engine.notebooks.read(source.notebookId);
    if (!completed.ok) throw new Error(completed.error.message);
    expect(completed.value.execution?.[producer.id]).toMatchObject({
      status: "completed",
      runId: jobId,
    });
    expect(completed.value.execution?.[producer.id]).not.toHaveProperty("error");
    expect(completed.value.execution?.[outputCell.id]).toMatchObject({
      status: "completed",
      runId: jobId,
    });
    expect(completed.value.execution?.[outputCell.id]).not.toHaveProperty("error");
    for (const cellId of [producer.id, outputCell.id]) {
      const cell = completed.value.cells.find((candidate) => candidate.id === cellId);
      expect(cell?.inputs).toMatchObject({ state: "completed" });
      expect(cell?.inputs).not.toHaveProperty("error");
    }
    const completedGenerations = engine.generations.listForCell(
      source.notebookId,
      producer.id,
    );
    if (!completedGenerations.ok) {
      throw new Error(completedGenerations.error.message);
    }
    expect(completedGenerations.value[0]).toMatchObject({
      status: "completed",
      outputArtifactId: output.value.artifactId,
    });
    expect(completedGenerations.value[0]).not.toHaveProperty("error");
  });

  it("returns the cached map and rejects stale source hashes", async () => {
    const source = await createSource();
    const result = await client.callTool({
      name: "get_image_subject_map",
      arguments: {
        book_id: bookId,
        artifact_id: source.artifactId,
        object_hash: source.objectHash,
      },
    });
    expect(result.isError).not.toBe(true);
    const parsed = resultJson(result);
    expect(parsed.status).toBe("ready");
    expect(parsed.base_url).toContain("/.image-subjects/");
    expect(parsed.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "person",
        label: "Person",
        capabilities: { remove: true, exact_edit: false },
      }),
    ]));

    const stale = await client.callTool({
      name: "get_image_subject_map",
      arguments: {
        book_id: bookId,
        artifact_id: source.artifactId,
        object_hash: "stale-object-hash",
      },
    });
    expect(stale.isError).toBe(true);
  });

  it("removes selected subjects into a connected non-destructive image output", async () => {
    const source = await createSource();
    const result = await client.callTool({
      name: "edit_image_subjects",
      arguments: {
        book_id: bookId,
        notebook_id: source.notebookId,
        source_cell_id: source.sourceCellId,
        artifact_id: source.artifactId,
        object_hash: source.objectHash,
        subject_ids: ["person"],
        operation: "remove",
      },
    });
    expect(result.isError).not.toBe(true);
    const parsed = resultJson(result) as {
      job_id: string;
      output_artifact_id: string;
      producer_cell_id: string;
      output_cell_id: string;
    };
    await waitForJob(parsed.job_id, 30_000);

    const outputRead = await engine.files.read(parsed.output_artifact_id, "original.png");
    expect(outputRead.ok).toBe(true);
    if (!outputRead.ok) return;
    const output = Buffer.from(outputRead.value);
    expect(await pixel(output, 15, 15)).toEqual([20, 40, 180, 255]);
    expect(await pixel(output, 65, 65)).toEqual([20, 220, 40, 255]);

    const sourceRead = await engine.files.read(source.artifactId, "original.png");
    expect(sourceRead.ok).toBe(true);
    if (!sourceRead.ok) return;
    expect(Buffer.from(sourceRead.value).equals(source.original)).toBe(true);

    const notebook = engine.notebooks.read(source.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.cells.find((cell) => cell.id === parsed.producer_cell_id)).toMatchObject({
      type: "generate_image",
      tool: "edit_image_subjects",
      slot: { row: 0, column: 1 },
      inputs: expect.objectContaining({ state: "completed" }),
    });
    expect(notebook.value.cells.find((cell) => cell.id === parsed.output_cell_id)).toMatchObject({
      type: "image",
      slot: { row: 0, column: 2 },
      outputArtifactId: parsed.output_artifact_id,
      inputs: expect.objectContaining({ state: "completed" }),
    });
    expect(notebook.value.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: source.sourceCellId,
        target: parsed.producer_cell_id,
        targetInput: "image",
      }),
      expect.objectContaining({
        source: parsed.producer_cell_id,
        target: parsed.output_cell_id,
        targetInput: "media",
      }),
    ]));
  });

  it("builds a Seedream 5 Pro replacement request with the base image first", () => {
    const request = seedreamRegionReplacementRequest({
      imageUrls: [
        "https://example.test/base.png",
        "https://example.test/actor-a.png",
        "https://example.test/actor-b.png",
      ],
      prompt: regionReplacementPrompt(
        null,
        [
          {
            box: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
            replacementArtifactId: "actor-a",
          },
          {
            box: { x: 0.6, y: 0.6, width: 0.25, height: 0.2 },
            replacementArtifactId: "actor-b",
          },
        ],
        [
          { role: "base", artifactId: "base" },
          { role: "replacement", artifactId: "actor-a" },
          { role: "replacement", artifactId: "actor-b" },
        ],
        "Replace the two actors",
      ),
      width: 1920,
      height: 1080,
    });
    expect(request.model).toBe("seedream/5-pro-image-to-image");
    expect(request.input.image_urls).toEqual([
      "https://example.test/base.png",
      "https://example.test/actor-a.png",
      "https://example.test/actor-b.png",
    ]);
    expect(request.input.prompt).toContain("Replace the two actors");
    expect(request.input.prompt).toContain("reference image 2");
    expect(request.input.prompt).toContain("reference image 3");
    expect(request.input.aspect_ratio).toBe("16:9");
  });

  it("replaces two regions with two reference artifacts via Seedream 5 Pro", async () => {
    const originalKey = process.env.KIE_API_KEY;
    process.env.KIE_API_KEY = "test-key";
    try {
      const source = await createSource();
      const left = await engine.artifacts.create({ kind: "image", label: "Actor A" });
      const right = await engine.artifacts.create({ kind: "image", label: "Actor B" });
      if (!left.ok || !right.ok) throw new Error("Failed to create replacement artifacts");
      const leftPng = await solidPng(32, 32, { r: 12, g: 34, b: 56 });
      const rightPng = await solidPng(32, 32, { r: 210, g: 20, b: 40 });
      const leftWrite = await engine.files.write(left.value.artifactId, "original.png", leftPng);
      const rightWrite = await engine.files.write(right.value.artifactId, "original.png", rightPng);
      if (!leftWrite.ok || !rightWrite.ok) throw new Error("Failed to write replacement images");

      const result = await client.callTool({
        name: "edit_image_subjects",
        arguments: {
          book_id: bookId,
          notebook_id: source.notebookId,
          source_cell_id: source.sourceCellId,
          artifact_id: source.artifactId,
          object_hash: source.objectHash,
          operation: "replace",
          regions: [
            {
              box: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
              subject_id: "person",
              replacement_artifact_id: left.value.artifactId,
            },
            {
              box: { x: 0.6, y: 0.6, width: 0.25, height: 0.2 },
              replacement_artifact_id: right.value.artifactId,
            },
          ],
        },
      });
      expect(result.isError).not.toBe(true);
      const parsed = resultJson(result) as {
        job_id: string;
        output_artifact_id: string;
        producer_cell_id: string;
        output_cell_id: string;
      };
      const output = engine.artifacts.get(parsed.output_artifact_id);
      expect(output.ok).toBe(true);
      if (output.ok) expect(output.value.kind).toBe("image");
      const provenance = await engine.metadata.artifacts.read<Record<string, unknown>>(
        parsed.output_artifact_id,
        "original",
      );
      expect(provenance.ok).toBe(true);
      if (provenance.ok) {
        expect(provenance.value.origin).toBe("image_subject_replace");
        expect(provenance.value.replacement_artifact_ids).toEqual([
          left.value.artifactId,
          right.value.artifactId,
        ]);
        expect(provenance.value.model).toBe("seedream/5-pro-image-to-image");
      }
      const jobs = engine.jobs.queue.list({
        type: "generate_image_subject_edit",
      });
      const job = jobs.find((entry) => entry.payload.jobId === parsed.job_id)
        ?? jobs.find((entry) => entry.payload.imageAssetId === parsed.output_artifact_id);
      expect(job).toBeTruthy();
      expect(job?.payload).toMatchObject({
        operation: "replace",
        sourceArtifactId: source.artifactId,
        orderedImageRefs: [
          { role: "base", artifactId: source.artifactId },
          { role: "replacement", artifactId: left.value.artifactId },
          { role: "replacement", artifactId: right.value.artifactId },
        ],
      });
      const orderedRefs = job?.payload.orderedImageRefs as
        | Array<{ role: string; artifactId: string }>
        | undefined;
      expect(orderedRefs?.[0]).toEqual({
        role: "base",
        artifactId: source.artifactId,
      });
    } finally {
      if (originalKey) process.env.KIE_API_KEY = originalKey;
      else delete process.env.KIE_API_KEY;
    }
  });

  it("rejects a replacement that exceeds Seedream 5 Pro image_urls capacity", async () => {
    const originalKey = process.env.KIE_API_KEY;
    process.env.KIE_API_KEY = "test-key";
    try {
      const source = await createSource();
      const tooMany = Array.from(
        { length: SEEDREAM_PRO_I2I_MAX_IMAGE_URLS },
        (_, index) => ({
          box: { x: 0.01, y: 0.01, width: 0.1, height: 0.1 },
          replacement_artifact_id: `replacement-${index + 1}`,
        }),
      );
      const result = await client.callTool({
        name: "edit_image_subjects",
        arguments: {
          book_id: bookId,
          notebook_id: source.notebookId,
          source_cell_id: source.sourceCellId,
          artifact_id: source.artifactId,
          object_hash: source.objectHash,
          operation: "replace",
          regions: tooMany,
        },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as TextContent)[0]!.text;
      expect(text).toBe(seedreamProImageUrlCapacityError(SEEDREAM_PRO_I2I_MAX_IMAGE_URLS));
      expect(text).toContain(String(SEEDREAM_PRO_I2I_MAX_IMAGE_URLS));
    } finally {
      if (originalKey) process.env.KIE_API_KEY = originalKey;
      else delete process.env.KIE_API_KEY;
    }
  });
});
