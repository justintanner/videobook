import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFs } from "videocity-engine";
import type { VideocityFs } from "videocity-engine";
import { clearPlanSceneFrameSwapDef } from "./clear-plan-scene-frame-swap.js";

type TextContent = Array<{ type: string; text: string }>;
type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } };

const PROJECT = "test-proj";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("clear_plan_scene_frame_swap", () => {
  let tempDir: string;
  let fs: VideocityFs;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-clear-frame-swap-test-"));
    fs = createFs({ projectsDir: tempDir });
    unwrap(await fs.createProject(PROJECT));

    const project = unwrap(await fs.getProject(PROJECT));
    await mkdir(join(project.path, "plan"), { recursive: true });
    const sidecar = {
      scenes: [
        {
          start: 0,
          end: 8,
          visual: "scene",
          swap: {
            image1: "img-nbp-s1-1",
            image2: null,
            image1_accepted: true,
            image1_variants: { "nano-banana-pro": "img-nbp-s1-1", "gpt-image-2": "img-gi2-s1-1" },
          },
        },
      ],
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

  it("nulls the swap and drops that frame's accepted flag + variants", async () => {
    const result = await clearPlanSceneFrameSwapDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 0,
      frame_index: 1,
    });
    expect(result.isError).toBeFalsy();
    const onDisk = JSON.parse(
      Buffer.from(unwrap(await fs.readFile("plan", ".plan.json", PROJECT)) as Uint8Array).toString("utf-8"),
    ) as { scenes: Array<{ swap?: Record<string, unknown> | null }> };
    const swap = onDisk.scenes[0].swap!;
    expect(swap.image1).toBeNull();
    expect(swap.image1_accepted).toBeUndefined();
    expect(swap.image1_variants).toBeUndefined();
  });

  it("returns the updated sidecar in the response", async () => {
    const result = await clearPlanSceneFrameSwapDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 0,
      frame_index: 1,
    });
    const parsed = JSON.parse((result.content as TextContent)[0].text) as {
      sidecar: { scenes: Array<{ swap?: { image1: string | null } | null }> };
    };
    expect(parsed.sidecar.scenes[0].swap?.image1).toBeNull();
  });

  it("errors on an out-of-range scene index", async () => {
    const result = await clearPlanSceneFrameSwapDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 9,
      frame_index: 1,
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("out of range");
  });
});
