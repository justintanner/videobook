import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEngine,
  type Engine,
  type NotebookDocument,
} from "videobook-engine";
import { BookManager } from "../../server/src/book-manager.js";
import {
  assertKlingMotionControlDuration,
  type KlingMotionControlOrientation,
} from "../../server/src/kling-motion-control-duration.js";
import {
  generateKling30MotionControlVideoDef,
  selectMotionControlImageFiles,
} from "../../server/src/tools/generate-kling30-motion-control-video.js";
import { videobookDomainDefs } from "../../server/src/tools/videobook-domain.js";
import { prepareNotebookGeneration } from "../../server/src/jobs/run-notebook.js";
import { buildKlingOmniVideoPayload } from "../../server/src/payload-builders.js";
import {
  assertProviderPayload,
  transformProviderPrompt,
} from "../../server/src/provider-prompt-transform.js";

describe("Kling motion-control duration", () => {
  let rootDir: string;
  let engine: Engine;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-kling-motion-duration-"));
    engine = createEngine({
      rootDir,
      initialBookName: "kling-motion-duration",
    });
    await engine.ready;
  });

  afterEach(async () => {
    engine.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createMotionAsset(duration?: number): Promise<string> {
    const created = await engine.artifacts.create("video", "yt 3h3i_td5kce");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.files.write(
      created.value.artifactId,
      "original.mp4",
      Buffer.from("motion video"),
    );
    expect(written.ok).toBe(true);
    if (duration !== undefined) {
      const metadata = await engine.metadata.artifacts.write(
        created.value.artifactId,
        "original",
        { duration },
      );
      expect(metadata.ok).toBe(true);
    }
    return created.value.artifactId;
  }

  it("accepts the exact duration boundaries for both orientations", async () => {
    const motionArtifactId = await createMotionAsset(3);
    const cases: Array<[KlingMotionControlOrientation, number]> = [
      ["image", 3],
      ["image", 10],
      ["video", 3],
      ["video", 30],
    ];
    for (const [orientation, duration] of cases) {
      const metadata = await engine.metadata.artifacts.write(
        motionArtifactId,
        "original",
        { duration },
      );
      expect(metadata.ok).toBe(true);
      await expect(assertKlingMotionControlDuration(
        engine,
        motionArtifactId,
        orientation,
      )).resolves.toBe(duration);
    }
  });

  it("rejects durations outside each orientation range with actionable guidance", async () => {
    const motionArtifactId = await createMotionAsset(2.5);
    await expect(assertKlingMotionControlDuration(
      engine,
      motionArtifactId,
      "image",
    )).rejects.toThrow(/is 2\.5s.*at least 3s.*\/split/s);

    await engine.metadata.artifacts.write(motionArtifactId, "original", { duration: 10.5 });
    await expect(assertKlingMotionControlDuration(
      engine,
      `@${motionArtifactId}`,
      "image",
    )).rejects.toThrow(/is 10\.5s.*character_orientation=image.*character_orientation=video.*\/split/s);

    await engine.metadata.artifacts.write(motionArtifactId, "original", { duration: 30.5 });
    await expect(assertKlingMotionControlDuration(
      engine,
      motionArtifactId,
      "video",
    )).rejects.toThrow(/is 30\.5s.*character_orientation=video.*\/split/s);
  });

  it("rejects an invalid direct tool call before credentials or output creation", async () => {
    const image = await engine.artifacts.create("image", "character image");
    expect(image.ok).toBe(true);
    if (!image.ok) return;
    expect((await engine.files.write(
      image.value.artifactId,
      "original.png",
      Buffer.from("character image"),
    )).ok).toBe(true);
    const motionArtifactId = await createMotionAsset(12);
    const before = engine.artifacts.list().length;
    const previousApiKey = process.env.KIE_API_KEY;
    delete process.env.KIE_API_KEY;
    try {
      const result = await generateKling30MotionControlVideoDef(engine).handler({
        book_id: engine.book.get().bookId,
        character_image_refs: [`@${image.value.artifactId}`],
        motion_video_refs: [`@${motionArtifactId}`],
        character_orientation: "image",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(
        /is 12s.*character_orientation=video.*\/split/s,
      );
      expect(engine.artifacts.list()).toHaveLength(before);
    } finally {
      if (previousApiKey === undefined) delete process.env.KIE_API_KEY;
      else process.env.KIE_API_KEY = previousApiKey;
    }
  });

  it.each([
    ["original.png", "portrait"],
    ["original.jpg", "landscape"],
  ] as const)("selects %s instead of a generated %s crop", async (originalName, preferredOrientation) => {
    const image = await engine.artifacts.create("image", `character ${preferredOrientation}`);
    expect(image.ok).toBe(true);
    if (!image.ok) return;
    for (const filename of [
      "landscape.jpg",
      "portrait.jpg",
      "square.jpg",
      originalName,
    ]) {
      const written = await engine.files.write(
        image.value.artifactId,
        filename,
        Buffer.from(filename),
      );
      expect(written.ok).toBe(true);
    }
    const manifest = await engine.files.manifest(image.value.artifactId);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(selectMotionControlImageFiles(
      image.value.kind,
      manifest.value.files,
      preferredOrientation,
    ).map((file) => file.name)).toEqual([originalName]);
  });

  it("uses the motion-video orientation when an image has no canonical original", async () => {
    const image = await engine.artifacts.create("image", "legacy character");
    expect(image.ok).toBe(true);
    if (!image.ok) return;
    for (const filename of ["landscape.jpg", "portrait.jpg", "square.jpg"]) {
      const written = await engine.files.write(
        image.value.artifactId,
        filename,
        Buffer.from(filename),
      );
      expect(written.ok).toBe(true);
    }
    const manifest = await engine.files.manifest(image.value.artifactId);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(selectMotionControlImageFiles(
      image.value.kind,
      manifest.value.files,
      "portrait",
    ).map((file) => file.name)).toEqual(["portrait.jpg"]);
  });

  it("returns the same preflight from the notebook preview surface", async () => {
    const image = await engine.artifacts.create("image", "preview character");
    expect(image.ok).toBe(true);
    if (!image.ok) return;
    await engine.files.write(
      image.value.artifactId,
      "original.png",
      Buffer.from("preview character"),
    );
    const motionArtifactId = await createMotionAsset(12);
    const motion = engine.artifacts.get(motionArtifactId);
    expect(motion.ok).toBe(true);
    if (!motion.ok) return;
    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    const imageCell = engine.notebooks.createCell({
      type: "image",
      label: "preview character",
      slot: { row: 0, column: 4 },
      outputArtifactId: image.value.artifactId,
    });
    const videoCell = engine.notebooks.createCell({
      type: "video",
      label: "preview motion",
      slot: { row: 0, column: 1 },
      outputArtifactId: motion.value.artifactId,
    });
    const generationCell = engine.notebooks.createCell({
      type: "generate_video",
      label: "preview motion generation",
      slot: { row: 2, column: 3 },
      prompt: "Follow the reference motion",
      provider: "kie",
      model: "kling-3.0-omni/transformation",
      operation: "transformation",
      tool: "generate_kie_kling_3_0_omni_transformation",
      inputs: {
        generationSettings: {
          resolution: "720p",
          aspect_ratio: "9:16",
        },
      },
    });
    const document: NotebookDocument = {
      ...notebook.value,
      cells: [imageCell, videoCell, generationCell],
      edges: [
        engine.notebooks.createEdge({
          source: imageCell.id,
          target: generationCell.id,
          targetInput: "image",
        }),
        engine.notebooks.createEdge({
          source: videoCell.id,
          target: generationCell.id,
          targetInput: "video",
        }),
      ],
    };
    await engine.notebooks.write(document);

    const books = new BookManager({
      libraryDir: join(rootDir, "preview-books"),
      objectPrefix: "preview-objects",
    });
    await books.ready();
    try {
      const preview = videobookDomainDefs(engine, books).find((definition) =>
        definition.name === "preview_notebook_generation");
      if (!preview) throw new Error("Missing preview_notebook_generation");
      const invalid = await preview.handler({
        book_id: engine.book.get().bookId,
        notebook_id: document.id,
        cell_id: generationCell.id,
      });
      expect(invalid.isError).toBeUndefined();

      const videoOrientation = {
        ...generationCell,
        prompt: "motion reference @b1, character and appearance @e1",
        inputs: {
          generationSettings: {
            resolution: "720p",
            aspect_ratio: "9:16",
          },
        },
      };
      const validDocument: NotebookDocument = {
        ...document,
        cells: [imageCell, videoCell, videoOrientation],
      };
      await engine.notebooks.write(validDocument);
      const valid = await preview.handler({
        book_id: engine.book.get().bookId,
        notebook_id: document.id,
        cell_id: generationCell.id,
      });
      expect(valid.isError, valid.content[0]?.text).toBeUndefined();
      const value = JSON.parse(valid.content[0]!.text) as {
        payload: {
          input: {
            prompt: string;
            image_urls: string[];
            video_urls: string[];
            resolution: string;
            aspect_ratio: string;
          };
        };
        mentions: {
          prompt_leaks: unknown[];
          url_placeholders: Array<{
            path: string;
            reference: string;
            url: string;
          }>;
        };
      };
      expect(value.payload.input.prompt).toBe(
        "motion reference the source video, character and appearance reference image 1",
      );
      expect(value.payload.input.image_urls).toEqual([
        `http://url.resolved.later.for/${image.value.artifactId}`,
      ]);
      expect(value.payload.input.video_urls).toEqual([
        `http://url.resolved.later.for/${motion.value.artifactId}`,
      ]);
      expect(value.mentions.prompt_leaks).toEqual([]);
      expect(value.mentions.url_placeholders).toMatchObject([
        {
          path: "input.image_urls[0]",
          reference: `@${image.value.artifactId}`,
        },
        {
          path: "input.video_urls[0]",
          reference: `@${motion.value.artifactId}`,
        },
      ]);
      const preparedWire = await prepareNotebookGeneration(
        engine,
        validDocument,
        videoOrientation,
        engine.book.get().bookId,
      );
      const wirePrompt = transformProviderPrompt(
        preparedWire.tool,
        preparedWire.input,
      );
      const wirePayload = buildKlingOmniVideoPayload(
        "transformation",
        {
          prompt: wirePrompt ?? "",
          resolution: "720p",
          aspect_ratio: "9:16",
        },
        {
          imageUrls: ["https://cdn.example.test/character.png"],
          videoUrls: ["https://cdn.example.test/motion.mp4"],
        },
      );
      expect(wirePayload).toEqual({
        ...value.payload,
        input: {
          ...value.payload.input,
          image_urls: ["https://cdn.example.test/character.png"],
          video_urls: ["https://cdn.example.test/motion.mp4"],
        },
      });
      expect(() => assertProviderPayload(wirePayload, {
        toolName: "generate_kie_kling_3_0_omni_transformation",
        wire: true,
      })).not.toThrow();
      const unresolvedCell = {
        ...videoOrientation,
        prompt: "unknown source @a3",
      };
      const unresolvedDocument: NotebookDocument = {
        ...validDocument,
        cells: [imageCell, videoCell, unresolvedCell],
      };
      await engine.notebooks.write(unresolvedDocument);
      const unresolved = await preview.handler({
        book_id: engine.book.get().bookId,
        notebook_id: document.id,
        cell_id: generationCell.id,
      });
      expect(unresolved.isError, unresolved.content[0]?.text).toBeUndefined();
      const unresolvedValue = JSON.parse(unresolved.content[0]!.text) as {
        payload: unknown;
        mentions: {
          prompt_leaks: Array<{
            token: string;
            code: string;
            message: string;
          }>;
        };
      };
      expect(unresolvedValue.payload).toBeNull();
      expect(unresolvedValue.mentions.prompt_leaks).toMatchObject([{
        token: "@a3",
        code: "not_found",
      }]);
      await expect(prepareNotebookGeneration(
        engine,
        unresolvedDocument,
        unresolvedCell,
        engine.book.get().bookId,
      )).rejects.toThrow("Notebook reference @a3 was not found");
    } finally {
      await books.close();
    }
  });
});
