import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFs } from "videocity-engine";
import type { VideocityFs } from "videocity-engine";
import { setPlanSceneFrameSourceDef } from "./set-plan-scene-frame-source.js";

type TextContent = Array<{ type: string; text: string }>;
type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } };

const PROJECT = "test-proj";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

type Scene = {
  frame_source?: { image1?: boolean; image2?: boolean };
  swap?: { image1: string | null; image2: string | null; image1_accepted?: boolean } | null;
};

describe("set_plan_scene_frame_source", () => {
  let tempDir: string;
  let fs: VideocityFs;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-frame-source-test-"));
    fs = createFs({ projectsDir: tempDir });
    unwrap(await fs.createProject(PROJECT));

    const project = unwrap(await fs.getProject(PROJECT));
    await mkdir(join(project.path, "plan"), { recursive: true });
    const sidecar = {
      scenes: [{ start: 0, end: 8, visual: "scene", swap: { image1: "img-x", image2: null, image1_accepted: true } }],
      source_asset_id: "vid-source",
      characters: [{ asset_id: "char-a", name: "C1", description: "" }],
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

  async function readScene(): Promise<Scene> {
    const parsed = JSON.parse(
      Buffer.from(unwrap(await fs.readFile("plan", ".plan.json", PROJECT)) as Uint8Array).toString("utf-8"),
    ) as { scenes: Scene[] };
    return parsed.scenes[0];
  }

  it("sets frame_source.image1 and nulls that frame's swap when use_source is true", async () => {
    const result = await setPlanSceneFrameSourceDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 0,
      frame_index: 1,
      use_source: true,
    });
    expect(result.isError).toBeFalsy();
    const scene = await readScene();
    expect(scene.frame_source?.image1).toBe(true);
    // Skipping to source overrides the selected swap for that frame.
    expect(scene.swap?.image1).toBeNull();
  });

  it("leaves the other frame's swap untouched", async () => {
    await setPlanSceneFrameSourceDef(fs).handler({ project_slug: PROJECT, scene_index: 0, frame_index: 2, use_source: true });
    const scene = await readScene();
    expect(scene.frame_source?.image2).toBe(true);
    expect(scene.swap?.image1).toBe("img-x");
  });

  it("removes the flag (and drops empty frame_source) when use_source is false", async () => {
    await setPlanSceneFrameSourceDef(fs).handler({ project_slug: PROJECT, scene_index: 0, frame_index: 1, use_source: true });
    await setPlanSceneFrameSourceDef(fs).handler({ project_slug: PROJECT, scene_index: 0, frame_index: 1, use_source: false });
    expect((await readScene()).frame_source).toBeUndefined();
  });

  it("errors on an out-of-range scene index", async () => {
    const result = await setPlanSceneFrameSourceDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 9,
      frame_index: 1,
      use_source: true,
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("out of range");
  });
});
