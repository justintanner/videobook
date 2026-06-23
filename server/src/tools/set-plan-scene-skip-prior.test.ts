import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFs } from "videocity-engine";
import type { VideocityFs } from "videocity-engine";
import { setPlanSceneSkipPriorDef } from "./set-plan-scene-skip-prior.js";

type TextContent = Array<{ type: string; text: string }>;
type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } };

const PROJECT = "test-proj";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("set_plan_scene_skip_prior", () => {
  let tempDir: string;
  let fs: VideocityFs;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-skip-prior-test-"));
    fs = createFs({ projectsDir: tempDir });
    unwrap(await fs.createProject(PROJECT));

    const project = unwrap(await fs.getProject(PROJECT));
    await mkdir(join(project.path, "plan"), { recursive: true });
    const sidecar = {
      scenes: [{ start: 0, end: 8, visual: "scene" }],
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

  async function readScene(): Promise<{ skip_prior_swap?: boolean }> {
    const parsed = JSON.parse(
      Buffer.from(unwrap(await fs.readFile("plan", ".plan.json", PROJECT)) as Uint8Array).toString("utf-8"),
    ) as { scenes: Array<{ skip_prior_swap?: boolean }> };
    return parsed.scenes[0];
  }

  it("sets skip_prior_swap when skip is true", async () => {
    const result = await setPlanSceneSkipPriorDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 0,
      skip: true,
    });
    expect(result.isError).toBeFalsy();
    expect((await readScene()).skip_prior_swap).toBe(true);
  });

  it("removes the flag when skip is false (restore)", async () => {
    await setPlanSceneSkipPriorDef(fs).handler({ project_slug: PROJECT, scene_index: 0, skip: true });
    await setPlanSceneSkipPriorDef(fs).handler({ project_slug: PROJECT, scene_index: 0, skip: false });
    expect((await readScene()).skip_prior_swap).toBeUndefined();
  });

  it("errors on an out-of-range scene index", async () => {
    const result = await setPlanSceneSkipPriorDef(fs).handler({
      project_slug: PROJECT,
      scene_index: 9,
      skip: true,
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("out of range");
  });
});
