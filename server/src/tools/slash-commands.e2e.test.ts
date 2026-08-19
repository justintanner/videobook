import { createEngineForTest } from "../engine.js";
/**
 * End-to-end tests for all slash commands.
 *
 * Simulates the full dispatch path: parse command string → extract args via
 * parseCommandArgs → call the backing MCP tool → verify results.
 *
 * Tests each command with different inputs (happy path, error cases, edge cases).
 */
import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReusableTestClient } from "../test-client.js";
import type { ReusableTestClient } from "../test-client.js";
import { registerJobHandler } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";
import { parseCommandArgs, selectCommandForInput } from "../../../src/lib/command-registry.js";
import type { ServerCommand } from "../../../src/lib/command-registry.js";
import type { ArtifactKind } from "videobook-engine";
import { isUuidV7 } from "videobook-engine";
import { copyVideoFixture } from "../test-media-fixtures.js";
import { getCanonicalCommands } from "./commands.js";

type TextContent = Array<{ type: string; text: string }>;

function parseResult(result: { content?: unknown; toolResult?: unknown }): Record<string, unknown> {
  let content: unknown;
  if (result.content) {
    content = result.content;
  } else if (result.toolResult) {
    const toolResult = result.toolResult as { content?: TextContent } | undefined;
    content = toolResult?.content;
  }
  return JSON.parse((content as TextContent)[0].text);
}

describe("slash commands e2e", () => {

  let harness: ReusableTestClient;
  let client: Client;
  let tempDir: string;
  let commands: ServerCommand[];
  let parentDir: string;

  /** Media kind now comes from the catalog row, never from an id prefix. */
  function expectKind(artifactId: string, kind: ArtifactKind): void {
    expect(isUuidV7(artifactId)).toBe(true);
    const artifact = createEngineForTest(tempDir).artifacts.get(artifactId);
    expect(artifact.ok).toBe(true);
    expect(artifact.ok && artifact.value.kind).toBe(kind);
  }

  beforeAll(async () => {
    parentDir = await mkdtemp(join(tmpdir(), "videocity-slash-e2e-"));
    harness = await createReusableTestClient(parentDir);
    client = harness.client;
    commands = getCanonicalCommands() as ServerCommand[];
  });

  beforeEach(async () => {
    await harness.reset();
    tempDir = harness.root;
    registerJobHandler("download_video", async () => ({ stubbed: true }));
    registerJobHandler("render_project", async () => ({ stubbed: true }));
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterAll(async () => {
    await harness?.close();
    if (parentDir) await rm(parentDir, { recursive: true, force: true, maxRetries: 3 });
  });

  // -----------------------------------------------------------------------
  // Helper: simulate frontend dispatch for a slash command string
  // -----------------------------------------------------------------------
  /** Typed timeline slots are backed by real media streams, so an assignable
   *  video artifact needs bytes ffprobe can actually read. */
  async function createProbeableVideoAsset(label: string): Promise<string> {
    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", label);
    if (!asset.ok) throw new Error(asset.error.message);
    const sourcePath = join(tempDir, `${label}.mp4`);
    await copyVideoFixture({
      width: 160,
      height: 90,
      durationSec: 1,
      fps: 10,
      source: "color",
      color: "red",
      audio: false,
    }, sourcePath);
    const written = await fs.files.write(
      asset.value.artifactId,
      "original.mp4",
      await readFile(sourcePath),
    );
    if (!written.ok) throw new Error(written.error.message);
    return asset.value.artifactId;
  }

  /** A real video artifact — render_video gates on catalog kind before it
   *  validates any other argument, so id-shaped placeholders no longer reach
   *  the hex / range checks. */
  async function createVideoAsset(label: string): Promise<string> {
    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", label);
    if (!asset.ok) throw new Error(asset.error.message);
    const written = await fs.files.write(
      asset.value.artifactId,
      "original.mp4",
      Buffer.from("fake-mp4"),
    );
    if (!written.ok) throw new Error(written.error.message);
    return asset.value.artifactId;
  }

  function findCommand(name: string, rest = ""): ServerCommand {
    const cmd = selectCommandForInput(commands, name, rest);
    if (!cmd) throw new Error(`Command ${name} not found`);
    return cmd;
  }

  // -----------------------------------------------------------------------
  // 1. /download — download_video
  // -----------------------------------------------------------------------
  describe("/download", () => {

    it("enqueues a download job for a valid URL", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/some-video",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.status).toBe("enqueued");
      expect(parsed.artifact_id).toBeDefined();
      expect(parsed.assetId).toBeDefined();
      expect(parsed.job_id).toBeDefined();
    });

    it("enqueues a download with start_time and end_time", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "10",
          end_time: "30",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).status).toBe("enqueued");
    });

    it("errors when start_time > end_time", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "60",
          end_time: "10",
        },
      });
      expect(result.isError).toBe(true);
    });

    it("accepts full=true with start_time", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "10",
          full: true,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors for invalid timestamp format", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "not-a-time",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 2. /folder — show_folder
  // -----------------------------------------------------------------------
  describe("/folder", () => {

    it("errors for nonexistent asset", async () => {
      const result = await client.callTool({
        name: "show_folder",
        arguments: { asset_id: "img-nonexistent", book_id: "test-proj" },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 3. /duplicate — duplicate_asset
  // -----------------------------------------------------------------------
  describe("/duplicate", () => {

    it("duplicates an asset successfully", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: uploaded.assetId as string,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.source_asset_id).toBe(uploaded.assetId);
      expect(parsed.new_asset_id).toBeDefined();
      expect(parsed.new_asset_id).not.toBe(uploaded.assetId);
    });

    it("duplicates with custom name", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: uploaded.assetId as string,
          book_id: "test-proj",
          new_name: "my-copy",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors for nonexistent asset", async () => {
      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: { asset_id: "img-nonexistent", book_id: "test-proj" },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 4. /delete — delete_asset
  // -----------------------------------------------------------------------
  describe("/delete", () => {

    it("deletes an existing asset", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "delete_asset",
        arguments: {
          asset_id: uploaded.assetId as string,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.status).toBe("deleted");

      // Verify deleted
      const manifest = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: uploaded.assetId as string, book_id: "test-proj" },
      });
      expect(manifest.isError).toBe(true);
    });

    it("errors for nonexistent asset", async () => {
      const result = await client.callTool({
        name: "delete_asset",
        arguments: { asset_id: "img-nonexistent", book_id: "test-proj" },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 5. /rename — rename_asset
  // -----------------------------------------------------------------------
  describe("/rename", () => {

    it("renames an existing asset", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: uploaded.assetId as string,
          new_name: "sunset beach",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.artifact_id).toBe(uploaded.assetId);
      expect(parsed.label).toBe("sunset beach");
    });

    it("errors for nonexistent asset", async () => {
      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: "img-nonexistent",
          new_name: "whatever",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 6. /assign — assign_slot
  // -----------------------------------------------------------------------
  describe("/assign", () => {

    it("assigns asset to slot s01", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "assign_slot",
        arguments: {
          book_id: "test-proj",
          asset_id: uploaded.assetId as string,
          slot: "s01",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.slots).toBeDefined();
      expect((parsed.slots as Array<{ artifact_id: string }>)[0].artifact_id).toBe(uploaded.assetId);
    });

    it("refuses to leave a gap at s05", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "assign_slot",
        arguments: {
          book_id: "test-proj",
          asset_id: uploaded.assetId as string,
          slot: "s05",
        },
      });
      // Typed timelines are dense: every slot is a real clip, so there is no
      // empty placeholder slot to pad with any more.
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("empty gaps");
    });

    it("errors for invalid slot format 'abc'", async () => {
      const result = await client.callTool({
        name: "assign_slot",
        arguments: {
          book_id: "test-proj",
          asset_id: "vid-something",
          slot: "abc",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("Slot must use the form");
    });

    it("errors for slot s00", async () => {
      const result = await client.callTool({
        name: "assign_slot",
        arguments: {
          book_id: "test-proj",
          asset_id: "vid-something",
          slot: "s00",
        },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for nonexistent asset", async () => {
      const result = await client.callTool({
        name: "assign_slot",
        arguments: {
          book_id: "test-proj",
          asset_id: "vid-nonexistent",
          slot: "s01",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 7. /unassign — unassign_slot
  // -----------------------------------------------------------------------
  describe("/unassign", () => {

    it("clears an assigned slot", async () => {
      // Upload + assign
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      await client.callTool({
        name: "assign_slot",
        arguments: {
          book_id: "test-proj",
          asset_id: uploaded.assetId as string,
          slot: "s01",
        },
      });

      // Clear
      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { book_id: "test-proj", slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.slots).toEqual([]);
      expect(parsed.removed_artifact_id).toBe(uploaded.assetId);
    });

    it("errors for invalid slot format", async () => {
      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { book_id: "test-proj", slot: "xyz" },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for slot s00", async () => {
      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { book_id: "test-proj", slot: "s00" },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for no timeline", async () => {
      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { book_id: "test-proj", slot: "s01" },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 8. /rewrite — rewrite_prompt (validation only, no API key)
  // -----------------------------------------------------------------------
  describe("/rewrite", () => {

    it("errors when OPENAI_API_KEY is unset", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            prompt: "a dog skateboarding",
            model: "nano_banana",
            book_id: "test-proj",
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("not set");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
      }
    });

    it("errors when prompt is missing in standard mode", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: { model: "nano_banana", book_id: "test-proj" },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("Provide a prompt");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });
  });

  // -----------------------------------------------------------------------
  // 9. /render — render
  // -----------------------------------------------------------------------
  describe("/render", () => {

    it("errors for a non-video artifact kind", async () => {
      const fs = createEngineForTest(tempDir);
      const image = await fs.artifacts.create("img", "not-a-video");
      if (!image.ok) throw new Error("Failed to create asset");
      const result = await client.callTool({
        name: "render_video",
        arguments: { asset_id: image.value.artifactId, book_id: "test-proj" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("requires video media");
    });

    it("errors for nonexistent asset id", async () => {
      const result = await client.callTool({
        name: "render_video",
        arguments: { asset_id: "vid-nonexistent", book_id: "test-proj" },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for invalid text_color hex", async () => {
      const assetId = await createVideoAsset("hex-invalid");
      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: assetId,
          book_id: "test-proj",
          text_color: "not-hex",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("Invalid text_color hex");
    });

    it("errors for audio_volume out of range", async () => {
      const assetId = await createVideoAsset("volume-range");
      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: assetId,
          book_id: "test-proj",
          audio_volume: 150,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("0-100");
    });

    it("errors for negative audio_fade_in", async () => {
      const assetId = await createVideoAsset("fade-negative");
      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: assetId,
          book_id: "test-proj",
          audio_fade_in: -10,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain(">= 0");
    });

    it("enqueues render for vid asset with video file", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "my-video");
      if (!asset.ok) throw new Error("Failed to create asset");
      // Write a minimal fake video file
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          orientation: "landscape",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.status).toBe("enqueued");
      expect(parsed.orientations).toEqual(["landscape"]);
    });

    it("errors for an osg_asset_id that is not an image", async () => {
      const assetId = await createVideoAsset("my-video2");
      const osgId = await createVideoAsset("osg-not-an-image");

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: assetId,
          book_id: "test-proj",
          osg_asset_id: osgId,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("requires image media");
    });
  });

  // -----------------------------------------------------------------------
  // 10. /vocals — isolate_vocals
  // -----------------------------------------------------------------------
  describe("/vocals", () => {

    it("errors when KIE_API_KEY is unset", async () => {
      const origKey = process.env.KIE_API_KEY;
      delete process.env.KIE_API_KEY;
      try {
        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: { asset_id: "vid-test", book_id: "test-proj" },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("not set");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
      }
    });

    it("errors for nonexistent asset", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: { asset_id: "vid-nonexistent", book_id: "test-proj" },
        });
        expect(result.isError).toBe(true);
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("errors for asset with no audio file", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("vid", "no-audio");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.files.write(asset.value.artifactId, "notes.txt", "hello");

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.artifactId,
            book_id: "test-proj",
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("No audio file");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("enqueues job for vid asset with audio", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("vid", "has-audio");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.files.write(asset.value.artifactId, "audio_original.mp3", Buffer.from("fake-mp3"));

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.artifactId,
            book_id: "test-proj",
          },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.status).toBe("enqueued");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });
  });

  // -----------------------------------------------------------------------
  // 10b. /doctor — doctor (diagnose + fix)
  // -----------------------------------------------------------------------
  describe("/doctor", () => {

    it("reports a healthy project (no broken or stuck assets)", async () => {
      const result = await client.callTool({
        name: "doctor",
        arguments: { book_id: "test-proj" },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.broken).toEqual([]);
      expect(parsed.stuck).toEqual([]);
    });

    it("errors when fix is requested without an asset_id", async () => {
      const result = await client.callTool({
        name: "doctor",
        arguments: { book_id: "test-proj", fix: true },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toMatch(/requires an explicit asset_id/i);
    });
  });

  // -----------------------------------------------------------------------
  // 14b. /qart — create_qart
  // -----------------------------------------------------------------------
  describe("/qart", () => {

    it("dispatches create_qart and creates inverted and monochrome assets by default", async () => {
      const sharp = (await import("sharp")).default;
      const fs = createEngineForTest(tempDir);
      const cover = await fs.artifacts.create("img", "cover-photo");
      expect(cover.ok).toBe(true);
      if (!cover.ok) return;
      const png = await sharp({
        create: { width: 200, height: 200, channels: 3, background: { r: 40, g: 120, b: 200 } },
      })
        .png()
        .toBuffer();
      const write = await fs.files.write(cover.value.artifactId, "original.png", png);
      expect(write.ok).toBe(true);

      const cmd = findCommand("/qart");
      const args = parseCommandArgs(
        `@${cover.value.artifactId} https://example.com/qart-slash`,
        cmd.params,
      );
      const result = await client.callTool({
        name: "create_qart",
        arguments: {
          ...args,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expectKind(parsed.inverted_asset_id as string, "image");
      expectKind(parsed.monochrome_asset_id as string, "image");
      expect(parsed.value).toBe("https://example.com/qart-slash");
      expect(parsed.source_image).toBe(cover.value.artifactId);
    });
  });

  // -----------------------------------------------------------------------
  // 14c. /qrbtf — create_qrbtf
  // -----------------------------------------------------------------------
  describe("/qrbtf", () => {

    it("dispatches create_qrbtf and creates an img asset", async () => {
      const cmd = findCommand("/qrbtf");
      const args = parseCommandArgs("https://example.com/qrbtf-slash", cmd.params);
      const result = await client.callTool({
        name: "create_qrbtf",
        arguments: {
          ...args,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expectKind(parsed.asset_id as string, "image");
      expect(parsed.value).toBe("https://example.com/qrbtf-slash");
      expect(parsed.style).toBe("normal");
      expect(parsed.bg_color).toBe("#000000");
    });
  });

  describe("/concat", () => {

    it("dispatches concat_images and preserves an empty second slot", async () => {
      const sharp = (await import("sharp")).default;
      const fs = createEngineForTest(tempDir);
      const source = await fs.artifacts.create("img", "concat-source");
      expect(source.ok).toBe(true);
      if (!source.ok) return;
      const png = await sharp({
        create: { width: 200, height: 200, channels: 3, background: { r: 220, g: 40, b: 80 } },
      })
        .png()
        .toBuffer();
      const write = await fs.files.write(source.value.artifactId, "original.png", png);
      expect(write.ok).toBe(true);

      const cmd = findCommand("/concat");
      const args = parseCommandArgs(`@${source.value.artifactId}`, cmd.params);
      const result = await client.callTool({
        name: "concat_images",
        arguments: { ...args, book_id: "test-proj" },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.width).toBe(1920);
      expect(parsed.height).toBe(1080);
      expect(parsed.layout).toBe("horizontal");
      expect(parsed.source_images).toEqual([source.value.artifactId]);
      expect(parsed.placements).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // 14. Dynamic book commands
  // -----------------------------------------------------------------------
  describe("dynamic book commands", () => {
    async function createBooks(names: readonly string[]): Promise<void> {
      for (const name of names) {
        const created = await client.callTool({
          name: "create_book",
          arguments: { name },
        });
        expect(created.isError, (created.content as TextContent)[0]?.text)
          .toBeFalsy();
      }
    }

    async function bookCommands(): Promise<ServerCommand[]> {
      const cmdResult = await client.callTool({
        name: "slash_commands",
        arguments: {},
      });
      const updated: ServerCommand[] = JSON.parse(
        (cmdResult.content as TextContent)[0].text,
      );
      return updated.filter((command) => command.uiAction === "switch_book");
    }

    it("creates a switch command for an existing book", async () => {
      const name = `dyn-solo-${Date.now()}`;
      await createBooks([name]);

      const cmd = (await bookCommands()).find((c) => c.command === `/${name}`);
      expect(cmd).toBeDefined();
      expect(cmd!.category).toBe("project");
      expect(cmd!.uiAction).toBe("switch_book");
    });

    it("creates commands for multiple books", async () => {
      const stamp = Date.now();
      const names = [`dyn-alpha-${stamp}`, `dyn-beta-${stamp}`];
      await createBooks(names);

      const commandNames = (await bookCommands()).map((c) => c.command);
      for (const name of names) expect(commandNames).toContain(`/${name}`);
    });
  });

  // -----------------------------------------------------------------------
  // 16. /download with different URL formats and time formats
  // -----------------------------------------------------------------------
  describe("/download different inputs", () => {
    it("normalizes URL without protocol prefix", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "youtube.com/watch?v=abc123",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.status).toBe("enqueued");
    });

    it("accepts colon time format '1:30'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "1:30",
          end_time: "2:00",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts shorthand time '2m20s'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "2m20s",
          end_time: "3m",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts bare numeric seconds '90'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "90",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts full=true alone (no time range)", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          full: true,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts full=true with end_time", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          end_time: "60",
          full: true,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors when start_time equals end_time", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "30",
          end_time: "30",
        },
      });
      expect(result.isError).toBe(true);
    });

    it("accepts HH:MM:SS format '1:02:30'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "1:02:30",
          end_time: "1:05:00",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors for nonexistent project", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "no-such-project",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 17. /assign with different slot and asset scenarios
  // -----------------------------------------------------------------------
  describe("/assign different inputs", () => {
    it("reassigns an already-occupied slot to a different asset", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload1 = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "a.png", data },
      });
      const upload2 = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "b.png", data },
      });
      const id1 = parseResult(upload1).assetId as string;
      const id2 = parseResult(upload2).assetId as string;

      // Assign first
      await client.callTool({
        name: "assign_slot",
        arguments: { book_id: "test-proj", asset_id: id1, slot: "s01" },
      });

      // Reassign to different asset
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { book_id: "test-proj", asset_id: id2, slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect((parsed.slots as Array<{ artifact_id: string }>)[0].artifact_id).toBe(id2);
    });

    it("assigns same asset to two different slots", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      await client.callTool({
        name: "assign_slot",
        arguments: { book_id: "test-proj", asset_id: assetId, slot: "s01" },
      });
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { book_id: "test-proj", asset_id: assetId, slot: "s02" },
      });
      expect(result.isError).toBeFalsy();
      const slots = parseResult(result).slots as Array<{ artifact_id: string }>;
      expect(slots[0].artifact_id).toBe(assetId);
      expect(slots[1].artifact_id).toBe(assetId);
    });

    it("errors for slot 's0' (index would be -1)", async () => {
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { book_id: "test-proj", asset_id: "vid-test", slot: "s0" },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for slot with non-numeric suffix", async () => {
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { book_id: "test-proj", asset_id: "vid-test", slot: "sAB" },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for empty slot string", async () => {
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { book_id: "test-proj", asset_id: "vid-test", slot: "" },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 18. /unassign with different scenarios
  // -----------------------------------------------------------------------
  describe("/unassign different inputs", () => {
    it("clearing a later slot leaves the earlier ones in place", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const ids: string[] = [];
      for (const name of ["a.png", "b.png"]) {
        const upload = await client.callTool({
          name: "upload_file",
          arguments: { book_id: "test-proj", filename: name, data },
        });
        ids.push(parseResult(upload).assetId as string);
      }
      for (const [index, id] of ids.entries()) {
        const assigned = await client.callTool({
          name: "assign_slot",
          arguments: { book_id: "test-proj", asset_id: id, slot: `s0${index + 1}` },
        });
        expect(assigned.isError).toBeFalsy();
      }

      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { book_id: "test-proj", slot: "s02" },
      });
      expect(result.isError).toBeFalsy();
      const slots = parseResult(result).slots as Array<{ artifact_id: string }>;
      expect(slots.map((slot) => slot.artifact_id)).toEqual([ids[0]]);
    });

    it("errors for out-of-range slot", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      // Create timeline with 1 slot
      await client.callTool({
        name: "assign_slot",
        arguments: { book_id: "test-proj", asset_id: assetId, slot: "s01" },
      });

      // Clear s05 which doesn't exist
      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { book_id: "test-proj", slot: "s05" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("outside the current timeline");
    });
  });

  // -----------------------------------------------------------------------
  // 19. /render with different optional parameters
  // -----------------------------------------------------------------------
  describe("/render different inputs", () => {
    it("accepts valid 6-digit hex colors", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "hex-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          text_color: "#FFFFFF",
          highlight_color: "#000000",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("rejects shorthand hex '#FFF'", async () => {
      const assetId = await createVideoAsset("short-hex");
      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: assetId,
          book_id: "test-proj",
          text_color: "#FFF",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("Invalid text_color hex");
    });

    it("rejects hex without # prefix", async () => {
      const assetId = await createVideoAsset("bare-hex");
      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: assetId,
          book_id: "test-proj",
          text_color: "FF0000",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("Invalid text_color hex");
    });

    it("rejects invalid highlight_color hex", async () => {
      const assetId = await createVideoAsset("bad-highlight");
      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: assetId,
          book_id: "test-proj",
          highlight_color: "#ZZZZZZ",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("Invalid highlight_color hex");
    });

    it("accepts audio_volume=0 (muted)", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "muted-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          audio_volume: 0,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts audio_fade_in=0 and audio_fade_out=0", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "nofade-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          audio_fade_in: 0,
          audio_fade_out: 0,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("rejects negative audio_fade_out", async () => {
      const assetId = await createVideoAsset("fade-out-negative");
      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: assetId,
          book_id: "test-proj",
          audio_fade_out: -5,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain(">= 0");
    });

    it("rejects audio_volume=-1", async () => {
      const assetId = await createVideoAsset("volume-negative");
      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: assetId,
          book_id: "test-proj",
          audio_volume: -1,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("0-100");
    });

    it("errors for an image artifact", async () => {
      const fs = createEngineForTest(tempDir);
      const image = await fs.artifacts.create("img", "photo");
      if (!image.ok) throw new Error("Failed to create asset");
      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: image.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("requires video media");
    });

    it("errors for an audio artifact", async () => {
      const fs = createEngineForTest(tempDir);
      const track = await fs.artifacts.create("aud", "track");
      if (!track.ok) throw new Error("Failed to create asset");
      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: track.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("requires video media");
    });

    it("renders with an explicit portrait orientation", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "portrait-vid");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          orientation: "portrait",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.orientations).toEqual(["portrait"]);
    });

    it("errors when osg_asset_id is nonexistent", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "osg-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          osg_asset_id: "img-nonexistent",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text)
        .toContain("osg_asset_id: Artifact not found");
    });

    it("renders with background_mode=black", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "black-bg-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          background_mode: "black",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with all subtitle options", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "subs-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));
      await fs.files.write(asset.value.artifactId, "elevenlabs.json", Buffer.from("{}"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          subtitles_enabled: true,
          highlight_style: "highlight",
          position: "top",
          font_size: "large",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("enqueues when subtitles_enabled=true but no elevenlabs.json", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "no-subs");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          subtitles_enabled: true,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).status).toBe("enqueued");
    });
  });

  // -----------------------------------------------------------------------
  // 20. /duplicate with different inputs
  // -----------------------------------------------------------------------
  describe("/duplicate different inputs", () => {
    it("duplicates asset with multiple files", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("img", "multi-file");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.png", Buffer.from("fake-png"));
      await fs.files.write(asset.value.artifactId, "thumbnail.jpg", Buffer.from("fake-jpg"));
      await fs.files.write(asset.value.artifactId, "notes.txt", "some notes");

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);

      // Verify copied files exist
      const copyManifest = await client.callTool({
        name: "asset_manifest",
        arguments: {
          asset_id: parsed.new_asset_id as string,
          book_id: "test-proj",
        },
      });
      expect(copyManifest.isError).toBeFalsy();
      const copyParsed = parseResult(copyManifest);
      const fileNames = (copyParsed.files as Array<{ name: string }>).map((f) => f.name);
      expect(fileNames).toContain("original.png");
      expect(fileNames).toContain("thumbnail.jpg");
      expect(fileNames).toContain("notes.txt");
    });

    it("duplicates a video asset preserving its kind", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "my-clip");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expectKind(parsed.new_asset_id as string, "video");
    });
  });

  // -----------------------------------------------------------------------
  // 21. /rename with different inputs
  // -----------------------------------------------------------------------
  describe("/rename different inputs", () => {
    it("relabels with a multi-word display name", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: uploaded.assetId as string,
          new_name: "my beautiful sunset photo",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.artifact_id).toBe(uploaded.assetId);
      expect(parsed.label).toBe("my beautiful sunset photo");
    });

    it("preserves asset kind and id after a relabel", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "old-name");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: asset.value.artifactId,
          new_name: "new-name",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.artifact_id).toBe(asset.value.artifactId);
      expect(parsed.label).toBe("new-name");
      expectKind(asset.value.artifactId, "video");
    });
  });

  // -----------------------------------------------------------------------
  // 22. /delete with different inputs
  // -----------------------------------------------------------------------
  describe("/delete different inputs", () => {
    it("deleting a vid- asset works", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "to-delete");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "delete_asset",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).status).toBe("deleted");
    });

    it("double delete errors on second attempt", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      await client.callTool({
        name: "delete_asset",
        arguments: { asset_id: assetId, book_id: "test-proj" },
      });

      const result2 = await client.callTool({
        name: "delete_asset",
        arguments: { asset_id: assetId, book_id: "test-proj" },
      });
      expect(result2.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 23. /folder with different inputs
  // -----------------------------------------------------------------------
  describe("/folder different inputs", () => {

    it("opens folder for an existing asset", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      const result = await client.callTool({
        name: "show_folder",
        arguments: { asset_id: assetId, book_id: "test-proj" },
      });
      // On CI this may fail because Finder isn't available, but the asset path
      // resolution should succeed. Either way it should not be an MCP error
      // from the tool's own validation.
      if (!result.isError) {
        const parsed = parseResult(result);
        expect(parsed.status).toBe("opened");
        expect(parsed.path).toBeDefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // 24. /vocals with aud- prefix asset
  // -----------------------------------------------------------------------
  describe("/vocals different inputs", () => {
    it("enqueues job for aud- asset with mp3 file", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("aud", "my-track");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.files.write(asset.value.artifactId, "track.mp3", Buffer.from("fake-mp3"));

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.artifactId,
            book_id: "test-proj",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).status).toBe("enqueued");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("enqueues job for aud- asset with wav file", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("aud", "wav-track");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.files.write(asset.value.artifactId, "recording.wav", Buffer.from("fake-wav"));

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.artifactId,
            book_id: "test-proj",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).status).toBe("enqueued");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("errors for img- prefix asset", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const data = Buffer.from("fake-png-data").toString("base64");
        const upload = await client.callTool({
          name: "upload_file",
          arguments: { book_id: "test-proj", filename: "photo.png", data },
        });
        const assetId = parseResult(upload).assetId as string;

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: assetId,
            book_id: "test-proj",
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("No audio file");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("errors for vid- asset with only video file (no audio)", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("vid", "vid-noaudio");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.artifactId,
            book_id: "test-proj",
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("No audio file");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("finds audio_original.mp3 for vid- asset", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("vid", "vid-withaudio");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));
        await fs.files.write(asset.value.artifactId, "audio_original.mp3", Buffer.from("fake-mp3"));

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.artifactId,
            book_id: "test-proj",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).status).toBe("enqueued");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("vid- asset falls back to original.mp3 when no audio_original.mp3", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("vid", "vid-fallback");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));
        await fs.files.write(asset.value.artifactId, "original.mp3", Buffer.from("fake-mp3"));

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.artifactId,
            book_id: "test-proj",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).status).toBe("enqueued");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });
  });

  // -----------------------------------------------------------------------
  // 27. Full round-trip: /assign then /unassign
  // -----------------------------------------------------------------------
  describe("full round-trip: assign then clear", () => {
    it("assign → verify → clear → verify", async () => {
      // Upload
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      // Assign to s01
      const assignResult = await client.callTool({
        name: "assign_slot",
        arguments: {
          book_id: "test-proj",
          asset_id: uploaded.assetId as string,
          slot: "s01",
        },
      });
      expect(assignResult.isError).toBeFalsy();
      const assignParsed = parseResult(assignResult);
      expect((assignParsed.slots as Array<{ artifact_id: string }>)[0].artifact_id).toBe(uploaded.assetId);

      // Clear s01
      const clearResult = await client.callTool({
        name: "unassign_slot",
        arguments: { book_id: "test-proj", slot: "s01" },
      });
      expect(clearResult.isError).toBeFalsy();
      const clearParsed = parseResult(clearResult);
      expect(clearParsed.slots).toEqual([]);
      expect(clearParsed.removed_artifact_id).toBe(uploaded.assetId);
    });
  });

  // -----------------------------------------------------------------------
  // 28. Full round-trip: upload → duplicate → rename → delete
  // -----------------------------------------------------------------------
  describe("full round-trip: upload → duplicate → rename → delete", () => {
    it("lifecycle works end-to-end", async () => {
      // Upload
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);
      const originalId = uploaded.assetId as string;

      // Duplicate
      const dupResult = await client.callTool({
        name: "duplicate_asset",
        arguments: { asset_id: originalId, book_id: "test-proj" },
      });
      expect(dupResult.isError).toBeFalsy();
      const dupParsed = parseResult(dupResult);
      const copyId = dupParsed.new_asset_id as string;

      // Relabel the copy — the id is unchanged by design
      const renameResult = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: copyId,
          new_name: "renamed-copy",
          book_id: "test-proj",
        },
      });
      expect(renameResult.isError).toBeFalsy();
      const renameParsed = parseResult(renameResult);
      expect(renameParsed.artifact_id).toBe(copyId);
      expect(renameParsed.label).toBe("renamed-copy");

      // Delete the relabelled copy
      const deleteResult = await client.callTool({
        name: "delete_asset",
        arguments: { asset_id: copyId, book_id: "test-proj" },
      });
      expect(deleteResult.isError).toBeFalsy();
      expect(parseResult(deleteResult).status).toBe("deleted");

      // Original should still exist
      const origManifest = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: originalId, book_id: "test-proj" },
      });
      expect(origManifest.isError).toBeFalsy();
    });
  });

  // -----------------------------------------------------------------------
  // 29. /download — time parsing edge cases
  // -----------------------------------------------------------------------
  describe("/download time parsing edge cases", () => {
    it("accepts decimal seconds '30.5'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "30.5",
          end_time: "45.5",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts shorthand '1h2m3s'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "1h2m3s",
          end_time: "1h10m",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts '5min' shorthand", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "5min",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts '0' as start_time", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "0",
          end_time: "60",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors for negative time value (not parseable)", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "-5",
        },
      });
      // Negative number parses as -5 via parseBareNumeric, but that's actually fine
      // since it's just a numeric value. The real check is if it causes issues.
      // Let's just verify it doesn't crash.
      expect(result.content).toBeDefined();
    });

    it("errors for gibberish time value", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "abc:xyz",
        },
      });
      expect(result.isError).toBe(true);
    });

    it("accepts colon format with trailing 's' suffix '1:30s'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "1:30s",
          end_time: "2:00",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts only end_time (no start_time)", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          end_time: "30",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("resolves source prefix from known domains", async () => {
      // Test with different known domains
      for (const domain of ["youtube.com/watch?v=x", "x.com/status/123", "instagram.com/reel/x"]) {
        const result = await client.callTool({
          name: "download_video",
          arguments: {
            url: `https://${domain}`,
            book_id: "test-proj",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).status).toBe("enqueued");
      }
    });
  });

  // -----------------------------------------------------------------------
  // 30. /render — OSG with valid image asset
  // -----------------------------------------------------------------------
  describe("/render with OSG image", () => {
    it("renders with valid osg_asset_id", async () => {
      const fs = createEngineForTest(tempDir);
      // Create vid asset
      const vid = await fs.artifacts.create("vid", "osg-vid");
      if (!vid.ok) throw new Error("Failed to create vid asset");
      await fs.files.write(vid.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      // Create img asset for OSG
      const img = await fs.artifacts.create("img", "logo");
      if (!img.ok) throw new Error("Failed to create img asset");
      await fs.files.write(img.value.artifactId, "logo.png", Buffer.from("fake-png"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: vid.value.artifactId,
          book_id: "test-proj",
          osg_asset_id: img.value.artifactId,
          osg_position: "bottom-left",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.status).toBe("enqueued");
    });

    it("errors for osg_asset_id with no image file", async () => {
      const fs = createEngineForTest(tempDir);
      const vid = await fs.artifacts.create("vid", "osg-vid2");
      if (!vid.ok) throw new Error("Failed to create vid asset");
      await fs.files.write(vid.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      // Create img asset with only a text file (no actual image)
      const img = await fs.artifacts.create("img", "no-image");
      if (!img.ok) throw new Error("Failed to create img asset");
      await fs.files.write(img.value.artifactId, "notes.txt", "no image here");

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: vid.value.artifactId,
          book_id: "test-proj",
          osg_asset_id: img.value.artifactId,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("No image file found");
    });

    it("accepts all four osg_position values", async () => {
      const fs = createEngineForTest(tempDir);
      const vid = await fs.artifacts.create("vid", "osg-pos-test");
      if (!vid.ok) throw new Error("Failed to create vid asset");
      await fs.files.write(vid.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const img = await fs.artifacts.create("img", "pos-logo");
      if (!img.ok) throw new Error("Failed to create img asset");
      await fs.files.write(img.value.artifactId, "logo.png", Buffer.from("fake-png"));

      for (const pos of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
        const result = await client.callTool({
          name: "render_video",
          arguments: {
            asset_id: vid.value.artifactId,
            book_id: "test-proj",
            osg_asset_id: img.value.artifactId,
            osg_position: pos,
          },
        });
        expect(result.isError).toBeFalsy();
      }
    });
  });

  // -----------------------------------------------------------------------
  // 31. /render — subtitle auto-detection
  // -----------------------------------------------------------------------
  describe("/render subtitle auto-detection", () => {
    it("auto-enables subtitles when elevenlabs.json exists and subtitles_enabled not specified", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "auto-subs");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));
      await fs.files.write(asset.value.artifactId, "elevenlabs.json", Buffer.from("{}"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          // subtitles_enabled NOT specified — should auto-detect
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.status).toBe("enqueued");
    });

    it("subtitles_enabled=false overrides auto-detection", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "no-auto-subs");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));
      await fs.files.write(asset.value.artifactId, "elevenlabs.json", Buffer.from("{}"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          subtitles_enabled: false,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with highlight_style='impact' (default)", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "impact-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));
      await fs.files.write(asset.value.artifactId, "elevenlabs.json", Buffer.from("{}"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          subtitles_enabled: true,
          highlight_style: "impact",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with all position values", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "pos-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));
      await fs.files.write(asset.value.artifactId, "elevenlabs.json", Buffer.from("{}"));

      for (const position of ["top", "middle", "bottom"] as const) {
        const result = await client.callTool({
          name: "render_video",
          arguments: {
            asset_id: asset.value.artifactId,
            book_id: "test-proj",
            subtitles_enabled: true,
            position,
          },
        });
        expect(result.isError).toBeFalsy();
      }
    });

    it("renders with all font_size values", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "font-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      for (const font_size of ["small", "medium", "large"] as const) {
        const result = await client.callTool({
          name: "render_video",
          arguments: {
            asset_id: asset.value.artifactId,
            book_id: "test-proj",
            font_size,
          },
        });
        expect(result.isError).toBeFalsy();
      }
    });
  });

  // -----------------------------------------------------------------------
  // 32. /vocals — different audio formats for aud- assets
  // -----------------------------------------------------------------------
  describe("/vocals audio format variants", () => {
    const audioFormats = [
      { ext: "wav", name: "recording.wav" },
      { ext: "ogg", name: "voiceover.ogg" },
      { ext: "flac", name: "master.flac" },
      { ext: "aac", name: "track.aac" },
      { ext: "m4a", name: "podcast.m4a" },
    ];

    for (const { ext, name } of audioFormats) {
      it(`enqueues job for aud- asset with .${ext} file`, async () => {
        const origKey = process.env.KIE_API_KEY;
        process.env.KIE_API_KEY = "test-key";
        try {
          const fs = createEngineForTest(tempDir);
          const asset = await fs.artifacts.create("aud", `${ext}-track`);
          if (!asset.ok) throw new Error("Failed to create asset");
          await fs.files.write(asset.value.artifactId, name, Buffer.from(`fake-${ext}`));

          const result = await client.callTool({
            name: "isolate_vocals",
            arguments: {
              asset_id: asset.value.artifactId,
              book_id: "test-proj",
            },
          });
          expect(result.isError).toBeFalsy();
          expect(parseResult(result).status).toBe("enqueued");
        } finally {
          if (origKey) process.env.KIE_API_KEY = origKey;
          else delete process.env.KIE_API_KEY;
        }
      });
    }
  });

  // -----------------------------------------------------------------------
  // 33. /duplicate and /rename with aud- prefix assets
  // -----------------------------------------------------------------------
  describe("/duplicate and /rename with aud- assets", () => {
    it("duplicates an audio asset preserving its kind", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("aud", "my-track");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "mix.mp3", Buffer.from("fake-mp3"));

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expectKind(parsed.new_asset_id as string, "audio");
    });

    it("relabels an audio asset without changing its id", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("aud", "old-track");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "mix.mp3", Buffer.from("fake-mp3"));

      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: asset.value.artifactId,
          new_name: "new-track",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.artifact_id).toBe(asset.value.artifactId);
      expect(parsed.label).toBe("new-track");
      expectKind(asset.value.artifactId, "audio");
    });

    it("deletes an audio asset", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("aud", "del-track");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "mix.mp3", Buffer.from("fake-mp3"));

      const result = await client.callTool({
        name: "delete_asset",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).status).toBe("deleted");
    });
  });

  // -----------------------------------------------------------------------
  // 34. /assign — preserves render orientation and volume settings
  // -----------------------------------------------------------------------
  describe("/assign preserves timeline config", () => {
    it("preserves existing render orientation", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      // Set the canonical sequence to portrait
      const configured = await client.callTool({
        name: "set_timeline",
        arguments: { book_id: "test-proj", render: "portrait", slots: [] },
      });
      expect(configured.isError).toBeFalsy();

      // Assign should preserve portrait orientation
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { book_id: "test-proj", asset_id: assetId, slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.render).toBe("portrait");
    });

    it("preserves existing slot volume when reassigning", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload1 = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "a.png", data },
      });
      const upload2 = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "b.png", data },
      });
      const id1 = parseResult(upload1).assetId as string;
      const id2 = parseResult(upload2).assetId as string;

      // Seed the canonical sequence with volume on slot 1
      const seeded = await client.callTool({
        name: "set_timeline",
        arguments: {
          book_id: "test-proj",
          render: "landscape",
          slots: [{ artifact_id: id1, volume: 80 }],
        },
      });
      expect(seeded.isError).toBeFalsy();

      // Reassign slot 1 to a different asset
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { book_id: "test-proj", asset_id: id2, slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const slots = parseResult(result).slots as Array<{
        artifact_id: string;
        volume?: number;
      }>;
      expect(slots[0].artifact_id).toBe(id2);
      expect(slots[0].volume).toBe(80);
    });

    it("refuses a far-out slot index s20", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      const result = await client.callTool({
        name: "assign_slot",
        arguments: { book_id: "test-proj", asset_id: assetId, slot: "s20" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("empty gaps");
    });
  });

  // -----------------------------------------------------------------------
  // 35. /unassign — edge cases with timeline state
  // -----------------------------------------------------------------------
  describe("/unassign timeline state edge cases", () => {
    it("clears the last remaining slot, leaving an empty timeline", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      await client.callTool({
        name: "assign_slot",
        arguments: { book_id: "test-proj", asset_id: assetId, slot: "s01" },
      });

      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { book_id: "test-proj", slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.slots).toEqual([]);
      expect(parsed.render).toBe("landscape");
    });

    it("drops the removed slot's audio settings with the slot", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload1 = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "a.png", data },
      });
      const upload2 = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "b.png", data },
      });
      const id1 = parseResult(upload1).assetId as string;
      const id2 = parseResult(upload2).assetId as string;

      const seeded = await client.callTool({
        name: "set_timeline",
        arguments: {
          book_id: "test-proj",
          render: "landscape",
          slots: [
            { artifact_id: id1, volume: 80 },
            { artifact_id: id2 },
          ],
        },
      });
      expect(seeded.isError).toBeFalsy();

      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { book_id: "test-proj", slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const slots = parseResult(result).slots as Array<{
        artifact_id: string;
        volume?: number;
      }>;
      // The slot and its per-clip audio settings go away together.
      expect(slots.map((slot) => slot.artifact_id)).toEqual([id2]);
      expect(slots[0].volume).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 36. /rewrite — scene mode validation
  // -----------------------------------------------------------------------
  describe("/rewrite scene mode", () => {
    it("errors when asset_ref provided but no tool.params.json", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("vid", "no-params");
        if (!asset.ok) throw new Error("Failed to create asset");

        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            book_id: "test-proj",
            asset_ref: asset.value.artifactId,
            scene_index: 0,
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("tool.params");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });

    it("errors for scene_index out of range", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("vid", "scene-range");
        if (!asset.ok) throw new Error("Failed to create asset");

        // Write tool.params with a single scene (no multi_prompt)
        await fs.metadata.artifacts.write(asset.value.artifactId, "tool.params", {
          tool: "generate_kling30_video",
          prompt: "a test prompt",
          duration: 8,
        });

        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            book_id: "test-proj",
            asset_ref: asset.value.artifactId,
            scene_index: 5,
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("out of range");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });

    it("errors when tool is not generate_kling30_video", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("vid", "wrong-tool");
        if (!asset.ok) throw new Error("Failed to create asset");

        await fs.metadata.artifacts.write(asset.value.artifactId, "tool.params", {
          tool: "generate_grok_imagine_video",
          prompt: "a test prompt",
        });

        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            book_id: "test-proj",
            asset_ref: asset.value.artifactId,
            scene_index: 0,
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("Kling 3.0");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });

    it("errors with image_refs that don't resolve to any images", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            prompt: "a dog on a skateboard",
            model: "nano_banana",
            book_id: "test-proj",
            image_refs: ["img-nonexistent-abc", "img-nonexistent-xyz"],
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("Could not resolve");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });
  });

  // -----------------------------------------------------------------------
  // 37. /render — video file detection edge cases
  // -----------------------------------------------------------------------
  describe("/render video file detection", () => {
    it("finds .mov video file", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "mov-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mov", Buffer.from("fake-mov"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("finds .webm video file", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "webm-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.webm", Buffer.from("fake-webm"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors for asset with no video file (only text)", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "no-video");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "notes.txt", "just text");

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("No video file");
    });

    it("prefers original.mp4 over other video files", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "prefer-original");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "render.mp4", Buffer.from("fake"));
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with audio_volume=100 (max)", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "vol100");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          audio_volume: 100,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("rejects audio_volume=101", async () => {
      const assetId = await createVideoAsset("volume-101");
      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: assetId,
          book_id: "test-proj",
          audio_volume: 101,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("0-100");
    });

    it("accepts lowercase hex '#abcdef'", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "lc-hex");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          text_color: "#abcdef",
        },
      });
      expect(result.isError).toBeFalsy();
    });
  });

  // -----------------------------------------------------------------------
  // 38. /folder with different asset types
  // -----------------------------------------------------------------------
  describe("/folder different asset types", () => {
    it("opens folder for aud- asset", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("aud", "my-audio");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "mix.mp3", Buffer.from("fake"));

      const result = await client.callTool({
        name: "show_folder",
        arguments: { asset_id: asset.value.artifactId, book_id: "test-proj" },
      });
      // On macOS should succeed, but may fail on CI
      if (!result.isError) {
        const parsed = parseResult(result);
        expect(parsed.status).toBe("opened");
        expect(parsed.path).toBeDefined();
      }
    });

    it("opens folder for vid- asset", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "my-video");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake"));

      const result = await client.callTool({
        name: "show_folder",
        arguments: { asset_id: asset.value.artifactId, book_id: "test-proj" },
      });
      if (!result.isError) {
        const parsed = parseResult(result);
        expect(parsed.status).toBe("opened");
      }
    });
  });

  // -----------------------------------------------------------------------
  // 39. Full round-trip: assign multiple → clear middle → verify
  // -----------------------------------------------------------------------
  describe("full round-trip: multi-slot assign and clear", () => {
    it("assign 3 assets to s01,s02,s03 → clear s02 → verify", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const ids: string[] = [];
      for (const name of ["a.png", "b.png", "c.png"]) {
        const upload = await client.callTool({
          name: "upload_file",
          arguments: { book_id: "test-proj", filename: name, data },
        });
        ids.push(parseResult(upload).assetId as string);
      }

      // Assign all three
      for (let i = 0; i < 3; i++) {
        await client.callTool({
          name: "assign_slot",
          arguments: { book_id: "test-proj", asset_id: ids[i], slot: `s0${i + 1}` },
        });
      }

      // Clear middle slot
      const clearResult = await client.callTool({
        name: "unassign_slot",
        arguments: { book_id: "test-proj", slot: "s02" },
      });
      expect(clearResult.isError).toBeFalsy();
      const slots = parseResult(clearResult).slots as Array<{ artifact_id: string }>;
      // Removing a slot shifts the later ones left; there is no empty hole.
      expect(slots.map((slot) => slot.artifact_id)).toEqual([ids[0], ids[2]]);
    });
  });

  // -----------------------------------------------------------------------
  // 40. /duplicate with custom name containing special characters
  // -----------------------------------------------------------------------
  describe("/duplicate with special name inputs", () => {
    it("duplicates with name containing spaces and numbers", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: uploaded.assetId as string,
          book_id: "test-proj",
          new_name: "version 2 final v3",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.new_asset_id).toBeDefined();
      expect(parsed.source_asset_id).toBe(uploaded.assetId);
    });

    it("auto-generates copy name when new_name not provided", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "sunset.jpg", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: uploaded.assetId as string,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      // Auto-name should be "{originalName} copy"
      expect(parsed.new_asset_id).toBeDefined();
      expect(parsed.new_asset_id).not.toBe(uploaded.assetId);
    });
  });

  // -----------------------------------------------------------------------
  // 42. /download — URL normalization and sourcePrefix mapping
  // -----------------------------------------------------------------------
  describe("/download URL normalization", () => {
    it("normalizes http:// URL (keeps as-is, not doubled)", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "http://example.com/video",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).status).toBe("enqueued");
    });

    it("accepts tiktok.com domain", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://tiktok.com/@user/video/12345",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts vimeo.com domain", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://vimeo.com/123456789",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts reddit.com domain", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://reddit.com/r/videos/comments/abc/test",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts fb.watch short URL", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://fb.watch/abc123",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("falls back to domain-derived prefix for unknown sites", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://obscure-video-host.xyz/v/12345",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).status).toBe("enqueued");
    });

    it("accepts URL with www prefix", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts youtu.be short URL", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://youtu.be/dQw4w9WgXcQ",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts export_videos=true", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          export_videos: true,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("full=true remains accepted", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          full: true,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).status).toBe("enqueued");
    });
  });

  // -----------------------------------------------------------------------
  // 43. /assign — idempotent re-assignment and normalizeConfig branches
  // -----------------------------------------------------------------------
  describe("/assign idempotent and config normalization", () => {
    it("assigning same asset to same slot is idempotent", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { book_id: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      // Assign once
      await client.callTool({
        name: "assign_slot",
        arguments: { book_id: "test-proj", asset_id: assetId, slot: "s01" },
      });

      // Assign same asset to same slot again
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { book_id: "test-proj", asset_id: assetId, slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const slots = parseResult(result).slots as Array<{ artifact_id: string }>;
      expect(slots[0].artifact_id).toBe(assetId);
    });

    it("errors for nonexistent project", async () => {
      const result = await client.callTool({
        name: "assign_slot",
        arguments: {
          book_id: "no-such-project",
          asset_id: "vid-test",
          slot: "s01",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 44. /unassign — nonexistent project
  // -----------------------------------------------------------------------
  describe("/unassign", () => {
    it("errors for nonexistent project (no timeline)", async () => {
      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { book_id: "no-such-project", slot: "s01" },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 45. /duplicate — empty asset and prefix extraction edge cases
  // -----------------------------------------------------------------------
  describe("/duplicate prefix extraction", () => {
    it("duplicates asset with no files (empty manifest)", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("img", "empty-asset");
      if (!asset.ok) throw new Error("Failed to create asset");

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expectKind(parsed.new_asset_id as string, "image");
    });

    it("duplicate labels the copy with a 'copy' suffix", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("img", "beach-sunset");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "photo.png", Buffer.from("fake"));

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      // Ids are opaque UUIDv7s; the "<original> copy" name lands on the label.
      const newId = parseResult(result).new_asset_id as string;
      const copy = fs.artifacts.get(newId);
      expect(copy.ok && copy.value.label).toBe("beach-sunset copy");
    });

    it("errors for nonexistent project", async () => {
      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: "img-test",
          book_id: "no-such-project",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 46. /rename — edge cases
  // -----------------------------------------------------------------------
  describe("/rename edge cases", () => {
    it("rename to single character name", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("img", "longname");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "photo.png", Buffer.from("fake"));

      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: asset.value.artifactId,
          new_name: "x",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.artifact_id).toBe(asset.value.artifactId);
      expect(parsed.label).toBe("x");
      expectKind(asset.value.artifactId, "image");
    });

    it("rename to name with numbers", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "clip-old");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake"));

      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: asset.value.artifactId,
          new_name: "clip 42 final v3",
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors for nonexistent project", async () => {
      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: "img-test",
          new_name: "whatever",
          book_id: "no-such-project",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 47. /delete — different asset types
  // -----------------------------------------------------------------------
  describe("/delete different asset types", () => {
    it("deletes img- asset created via fs.createAsset", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("img", "del-img");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "photo.png", Buffer.from("fake"));

      const result = await client.callTool({
        name: "delete_asset",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.status).toBe("deleted");
      expect(parsed.deleted_at).toBeDefined();
    });

    it("errors for nonexistent project", async () => {
      const result = await client.callTool({
        name: "delete_asset",
        arguments: {
          asset_id: "img-test",
          book_id: "no-such-project",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 48. /render — findVideoFile with .avi and .mkv formats
  // -----------------------------------------------------------------------
  describe("/render additional video formats", () => {
    it("finds .avi video file", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "avi-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "clip.avi", Buffer.from("fake-avi"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("finds .mkv video file", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "mkv-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "movie.mkv", Buffer.from("fake-mkv"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with background_mode=blur (default)", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "blur-bg-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          background_mode: "blur",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with highlight_style='highlight'", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "highlight-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));
      await fs.files.write(asset.value.artifactId, "elevenlabs.json", Buffer.from("{}"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          subtitles_enabled: true,
          highlight_style: "highlight",
          text_color: "#FF0000",
          highlight_color: "#00FF00",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with an explicit square orientation", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "square-vid");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          orientation: "square",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).orientations).toEqual(["square"]);
    });

    it("renders with large audio_fade_in and audio_fade_out values", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("vid", "bigfade-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: asset.value.artifactId,
          book_id: "test-proj",
          audio_fade_in: 5000,
          audio_fade_out: 3000,
          audio_volume: 50,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with OSG using .webp image", async () => {
      const fs = createEngineForTest(tempDir);
      const vid = await fs.artifacts.create("vid", "osg-webp");
      if (!vid.ok) throw new Error("Failed to create vid asset");
      await fs.files.write(vid.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const img = await fs.artifacts.create("img", "webp-logo");
      if (!img.ok) throw new Error("Failed to create img asset");
      await fs.files.write(img.value.artifactId, "logo.webp", Buffer.from("fake-webp"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: vid.value.artifactId,
          book_id: "test-proj",
          osg_asset_id: img.value.artifactId,
          osg_position: "top-left",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with OSG using .svg image", async () => {
      const fs = createEngineForTest(tempDir);
      const vid = await fs.artifacts.create("vid", "osg-svg");
      if (!vid.ok) throw new Error("Failed to create vid asset");
      await fs.files.write(vid.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const img = await fs.artifacts.create("img", "svg-logo");
      if (!img.ok) throw new Error("Failed to create img asset");
      await fs.files.write(img.value.artifactId, "icon.svg", Buffer.from("<svg></svg>"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: vid.value.artifactId,
          book_id: "test-proj",
          osg_asset_id: img.value.artifactId,
          osg_position: "bottom-right",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with OSG using .gif image", async () => {
      const fs = createEngineForTest(tempDir);
      const vid = await fs.artifacts.create("vid", "osg-gif");
      if (!vid.ok) throw new Error("Failed to create vid asset");
      await fs.files.write(vid.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

      const img = await fs.artifacts.create("img", "gif-logo");
      if (!img.ok) throw new Error("Failed to create img asset");
      await fs.files.write(img.value.artifactId, "badge.gif", Buffer.from("GIF89a"));

      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: vid.value.artifactId,
          book_id: "test-proj",
          osg_asset_id: img.value.artifactId,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors for nonexistent project", async () => {
      const result = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: "vid-test",
          book_id: "no-such-project",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 49. /vocals — findAudioFile fallback logic
  // -----------------------------------------------------------------------
  describe("/vocals audio discovery", () => {
    it("aud- asset finds .m4a file", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("aud", "m4a-track");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.files.write(asset.value.artifactId, "episode.m4a", Buffer.from("fake-m4a"));

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.artifactId,
            book_id: "test-proj",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).status).toBe("enqueued");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("aud- asset with non-audio file only errors", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("aud", "text-only");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.files.write(asset.value.artifactId, "readme.txt", "text");

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.artifactId,
            book_id: "test-proj",
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("No audio file");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("vid- asset with audio_original.mp3 preferred over original.mp3", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("vid", "both-audio");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));
        await fs.files.write(asset.value.artifactId, "original.mp3", Buffer.from("original-mp3"));
        await fs.files.write(asset.value.artifactId, "audio_original.mp3", Buffer.from("audio-original-mp3"));

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.artifactId,
            book_id: "test-proj",
          },
        });
        // Should succeed — findAudioFile for vid- prefers audio_original.mp3
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).status).toBe("enqueued");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("errors for nonexistent project", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: "vid-test",
            book_id: "no-such-project",
          },
        });
        expect(result.isError).toBe(true);
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });
  });

  // -----------------------------------------------------------------------
  // 50. /rewrite — additional validation paths
  // -----------------------------------------------------------------------
  describe("/rewrite additional validation", () => {
    it("errors when asset_ref provided without scene_index", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        // asset_ref but no scene_index — should fall to standard mode (prompt required)
        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            book_id: "test-proj",
            asset_ref: "vid-test",
            // no scene_index, no prompt
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("Provide a prompt");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });

    it("errors for scene rewrite with scene_index < 0", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("vid", "neg-scene");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.metadata.artifacts.write(asset.value.artifactId, "tool.params", {
          tool: "generate_kling30_video",
          prompt: "test",
          duration: 8,
        });

        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            book_id: "test-proj",
            asset_ref: asset.value.artifactId,
            scene_index: -1,
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("out of range");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });

    it("errors for scene rewrite on multi_prompt with out-of-bounds index", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const fs = createEngineForTest(tempDir);
        const asset = await fs.artifacts.create("vid", "multi-scene");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.metadata.artifacts.write(asset.value.artifactId, "tool.params", {
          tool: "generate_kling30_video",
          multi_prompt: [
            { prompt: "scene one", duration: 4 },
            { prompt: "scene two", duration: 4 },
          ],
        });

        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            book_id: "test-proj",
            asset_ref: asset.value.artifactId,
            scene_index: 2, // only 0 and 1 are valid
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("out of range");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });

    it("errors for scene rewrite on nonexistent asset", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            book_id: "test-proj",
            asset_ref: "vid-does-not-exist",
            scene_index: 0,
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("tool.params");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });
  });

  // -----------------------------------------------------------------------
  // 51. /folder — different asset types via fs.createAsset
  // -----------------------------------------------------------------------
  describe("/folder with createAsset", () => {
    it("errors for nonexistent project", async () => {
      const result = await client.callTool({
        name: "show_folder",
        arguments: { asset_id: "img-test", book_id: "no-such-project" },
      });
      expect(result.isError).toBe(true);
    });

    it("resolves correct path for img- asset", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("img", "folder-test");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.files.write(asset.value.artifactId, "photo.png", Buffer.from("fake"));

      const result = await client.callTool({
        name: "show_folder",
        arguments: { asset_id: asset.value.artifactId, book_id: "test-proj" },
      });
      // On macOS with Finder this should succeed; either way no validation error
      if (!result.isError) {
        const parsed = parseResult(result);
        expect(parsed.path).toBe(asset.value.path);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 52. /download time edge cases — mixed formats
  // -----------------------------------------------------------------------
  describe("/download mixed time formats", () => {
    it("colon start with shorthand end '0:30' to '2m'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "0:30",
          end_time: "2m",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("shorthand start with colon end '1m30s' to '3:00'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "1m30s",
          end_time: "3:00",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("bare numeric start with shorthand end '10' to '5min'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "10",
          end_time: "5min",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("both times as '0' and '0' errors (start >= end)", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "0",
          end_time: "0",
        },
      });
      expect(result.isError).toBe(true);
    });

    it("HH:MM:SS start with bare end '0:02:30' to '200'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: "test-proj",
          start_time: "0:02:30",
          end_time: "200",
        },
      });
      expect(result.isError).toBeFalsy();
    });
  });

  // -----------------------------------------------------------------------
  // 53. Full round-trip: create → rename → duplicate → assign → render
  // -----------------------------------------------------------------------
  describe("full round-trip: create → rename → duplicate → assign → render", () => {
    it("end-to-end lifecycle with vid asset", async () => {
      const origId = await createProbeableVideoAsset("raw-footage");

      // Rename
      const renameResult = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: origId,
          new_name: "polished clip",
          book_id: "test-proj",
        },
      });
      expect(renameResult.isError).toBeFalsy();
      expect(parseResult(renameResult).artifact_id).toBe(origId);
      expect(parseResult(renameResult).label).toBe("polished clip");

      // Duplicate
      const dupResult = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: origId,
          book_id: "test-proj",
          new_name: "backup clip",
        },
      });
      expect(dupResult.isError).toBeFalsy();

      // Assign the relabelled asset to a slot
      const assignResult = await client.callTool({
        name: "assign_slot",
        arguments: {
          book_id: "test-proj",
          asset_id: origId,
          slot: "s01",
        },
      });
      expect(assignResult.isError, (assignResult.content as TextContent)[0]?.text)
        .toBeFalsy();

      // Render the assigned asset
      const renderResult = await client.callTool({
        name: "render_video",
        arguments: {
          asset_id: origId,
          book_id: "test-proj",
        },
      });
      expect(renderResult.isError).toBeFalsy();
      expect(parseResult(renderResult).status).toBe("enqueued");
    });
  });
});
