import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createFs } from "videocity-engine";
import type { VideocityFs } from "videocity-engine";
import { setPlanSceneFrameCharactersDef } from "./set-plan-scene-frame-characters.js";

type TextContent = Array<{ type: string; text: string }>;
type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } };

const PROJECT = "test-proj";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function testPng(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 128, b: 0, alpha: 1 } } })
    .png()
    .toBuffer();
}

describe("set_plan_scene_frame_characters", () => {
  let tempDir: string;
  let fs: VideocityFs;
  let chars: string[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-set-frame-chars-test-"));
    fs = createFs({ projectsDir: tempDir });
    unwrap(await fs.createProject(PROJECT));

    chars = [];
    const png = await testPng();
    for (const name of ["char-a", "char-b"]) {
      const asset = unwrap(await fs.createAsset("img", name, PROJECT));
      unwrap(await fs.writeFile(asset.assetId, "original.png", png, PROJECT));
      chars.push(asset.assetId);
    }

    const project = unwrap(await fs.getProject(PROJECT));
    await mkdir(join(project.path, "plan"), { recursive: true });
    const sidecar = {
      scenes: [{ start: 0, end: 8, visual: "scene" }],
      source_asset_id: "vid-source",
      characters: chars.map((assetId, i) => ({ asset_id: assetId, name: `C${i + 1}`, description: "" })),
      total_duration_s: 8,
      max_scene_seconds: 14,
      model: "test",
    };
    unwrap(await fs.writeFile("plan", ".plan.json", JSON.stringify(sidecar, null, 2), PROJECT));
  });

  afterEach(async () => {
    fs.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  function parseSidecar(text: string): { scenes: Array<{ frame_characters?: { image1?: string[]; image2?: string[] } }> } {
    return JSON.parse(text) as { scenes: Array<{ frame_characters?: { image1?: string[]; image2?: string[] } }> };
  }

  it("wires a single character to a frame and persists it", async () => {
    const result = await setPlanSceneFrameCharactersDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 0,
      frame_index: 1,
      character_asset_ids: [`@${chars[0]}`],
    });
    expect(result.isError).toBeFalsy();
    const sidecar = parseSidecar((result.content as TextContent)[0].text)["scenes"];
    // @ is stripped on write.
    const onDisk = parseSidecar(Buffer.from(unwrap(await fs.readFile("plan", ".plan.json", PROJECT)) as Uint8Array).toString("utf-8"));
    expect(onDisk.scenes[0].frame_characters?.image1).toEqual([chars[0]]);
    void sidecar;
  });

  it("wires two characters to the other frame, in order", async () => {
    const result = await setPlanSceneFrameCharactersDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 0,
      frame_index: 2,
      character_asset_ids: [chars[1], chars[0]],
    });
    expect(result.isError).toBeFalsy();
    const onDisk = parseSidecar(Buffer.from(unwrap(await fs.readFile("plan", ".plan.json", PROJECT)) as Uint8Array).toString("utf-8"));
    expect(onDisk.scenes[0].frame_characters?.image2).toEqual([chars[1], chars[0]]);
    // image1 stays unset.
    expect(onDisk.scenes[0].frame_characters?.image1).toBeUndefined();
  });

  it("de-duplicates repeated ids", async () => {
    const result = await setPlanSceneFrameCharactersDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 0,
      frame_index: 1,
      character_asset_ids: [chars[0], chars[0]],
    });
    expect(result.isError).toBeFalsy();
    const onDisk = parseSidecar(Buffer.from(unwrap(await fs.readFile("plan", ".plan.json", PROJECT)) as Uint8Array).toString("utf-8"));
    expect(onDisk.scenes[0].frame_characters?.image1).toEqual([chars[0]]);
  });

  it("clears the wiring when given an empty list (falls back to all)", async () => {
    // Wire one character, then clear it.
    await setPlanSceneFrameCharactersDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 0,
      frame_index: 1,
      character_asset_ids: [chars[0]],
    });
    const cleared = await setPlanSceneFrameCharactersDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 0,
      frame_index: 1,
      character_asset_ids: [],
    });
    expect(cleared.isError).toBeFalsy();
    const onDisk = parseSidecar(Buffer.from(unwrap(await fs.readFile("plan", ".plan.json", PROJECT)) as Uint8Array).toString("utf-8"));
    // The image1 key is removed entirely so consumers fall back to all characters.
    expect(onDisk.scenes[0].frame_characters?.image1).toBeUndefined();
  });

  it("rejects ids outside the character roster", async () => {
    const result = await setPlanSceneFrameCharactersDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 0,
      frame_index: 1,
      character_asset_ids: ["img-not-a-character"],
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("roster");
  });
});
