import { createEngineForTest } from "../fs.js";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { type Engine } from "videobook-engine";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

const ORIENTATIONS = ["landscape", "portrait", "square"] as const;

describe("set_osg tool", () => {
  let client: Client;
  let fs: Engine;
  let tempDir: string;
  const projectSlug = "test-proj";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-set-osg-test-"));
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: projectSlug },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createVideoAsset(): Promise<string> {
    const created = await fs.artifacts.create("vid", "clip", projectSlug);
    if (!created.ok) throw new Error(created.error.message);
    const write = await fs.files.write(created.value.slug, "original.mp4", Buffer.from("fake-video"), projectSlug);
    if (!write.ok) throw new Error(write.error.message);
    return created.value.slug;
  }

  it("writes osg fields to the render metadata of every orientation", async () => {
    const assetId = await createVideoAsset();

    const result = await client.callTool({
      name: "set_video_overlay",
      arguments: {
        asset_id: assetId,
        project_slug: projectSlug,
        osg_asset_id: "img-logo",
        osg_position: "bottom-right",
        osg_size: "large",
        osg_scale: 1.5,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.osg).toEqual({ assetId: "img-logo", position: "bottom-right", size: "large", scale: 1.5 });

    for (const orient of ORIENTATIONS) {
      const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`, projectSlug);
      if (!meta.ok) throw new Error(`missing ${orient}.render`);
      expect(meta.value.osgAssetId).toBe("img-logo");
      expect(meta.value.osgPosition).toBe("bottom-right");
      expect(meta.value.osgSize).toBe("large");
      expect(meta.value.osgScale).toBe(1.5);
      // Legacy path must be nulled so it can't override the canonical asset id.
      expect(meta.value.osgImagePath).toBeNull();
    }
  });

  it("preserves unrelated render settings when merging osg fields", async () => {
    const assetId = await createVideoAsset();
    // Seed a pre-existing render setting that set_osg must not clobber.
    await fs.metadata.artifacts.write(assetId, "landscape.render", { subtitlesEnabled: false, textColor: "#ABCDEF" }, projectSlug);

    await client.callTool({
      name: "set_video_overlay",
      arguments: {
        asset_id: assetId,
        project_slug: projectSlug,
        osg_asset_id: "img-badge",
        osg_position: "top-left",
        osg_size: "small",
      },
    });

    const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, "landscape.render", projectSlug);
    if (!meta.ok) throw new Error("missing landscape.render");
    expect(meta.value.subtitlesEnabled).toBe(false);
    expect(meta.value.textColor).toBe("#ABCDEF");
    expect(meta.value.osgAssetId).toBe("img-badge");
    expect(meta.value.osgPosition).toBe("top-left");
    expect(meta.value.osgSize).toBe("small");
    expect(meta.value.osgScale).toBe(1);
  });

  it("persists an absolute visibility window and nulls the legacy tail", async () => {
    const assetId = await createVideoAsset();
    // Seed a legacy tail so we can prove an absolute window supersedes it.
    for (const orient of ORIENTATIONS) {
      await fs.metadata.artifacts.write(assetId, `${orient}.render`, { osgTailSeconds: 2 }, projectSlug);
    }

    const result = await client.callTool({
      name: "set_video_overlay",
      arguments: {
        asset_id: assetId,
        project_slug: projectSlug,
        osg_asset_id: "img-logo",
        osg_position: "top-right",
        osg_size: "medium",
        osg_start_seconds: 10,
        osg_end_seconds: 22,
      },
    });

    expect(result.isError).toBeFalsy();
    for (const orient of ORIENTATIONS) {
      const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`, projectSlug);
      if (!meta.ok) throw new Error(`missing ${orient}.render`);
      expect(meta.value.osgStartSeconds).toBe(10);
      expect(meta.value.osgEndSeconds).toBe(22);
      // The absolute window wins over (and clears) the legacy duration-relative tail.
      expect(meta.value.osgTailSeconds).toBeNull();
    }
  });

  it("clears the visibility window when the osg is removed", async () => {
    const assetId = await createVideoAsset();
    await client.callTool({
      name: "set_video_overlay",
      arguments: {
        asset_id: assetId,
        project_slug: projectSlug,
        osg_asset_id: "img-logo",
        osg_position: "top-right",
        osg_size: "medium",
        osg_start_seconds: 5,
        osg_end_seconds: 9,
      },
    });

    await client.callTool({
      name: "set_video_overlay",
      arguments: {
        asset_id: assetId,
        project_slug: projectSlug,
        osg_asset_id: null,
        osg_position: "top-right",
        osg_size: "medium",
      },
    });

    for (const orient of ORIENTATIONS) {
      const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`, projectSlug);
      if (!meta.ok) throw new Error(`missing ${orient}.render`);
      expect(meta.value.osgStartSeconds).toBeNull();
      expect(meta.value.osgEndSeconds).toBeNull();
    }
  });

  it("clears the osg when osg_asset_id is null", async () => {
    const assetId = await createVideoAsset();
    await client.callTool({
      name: "set_video_overlay",
      arguments: {
        asset_id: assetId,
        project_slug: projectSlug,
        osg_asset_id: "img-logo",
        osg_position: "bottom-right",
        osg_size: "medium",
      },
    });

    const cleared = await client.callTool({
      name: "set_video_overlay",
      arguments: {
        asset_id: assetId,
        project_slug: projectSlug,
        osg_asset_id: null,
        osg_position: "top-right",
        osg_size: "medium",
      },
    });

    expect(cleared.isError).toBeFalsy();
    const parsed = JSON.parse((cleared.content as TextContent)[0].text);
    expect(parsed.osg).toBeNull();

    for (const orient of ORIENTATIONS) {
      const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`, projectSlug);
      if (!meta.ok) throw new Error(`missing ${orient}.render`);
      expect(meta.value.osgAssetId).toBeNull();
      expect(meta.value.osgTailSeconds).toBeNull();
    }
  });
});
