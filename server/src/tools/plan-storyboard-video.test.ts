import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFs } from "vc-engine";
import type { VideocityFs } from "vc-engine";
import type { StoryboardVideoPlanSidecar, StoryboardVideoSourceAnalysis } from "../plan-types.js";
import { planStoryboardVideoDef } from "./plan-storyboard-video.js";
import { replacePlanStoryboardVideoStoryboardDef } from "./replace-plan-storyboard-video-storyboard.js";
import { replacePlanStoryboardVideoVideoDef } from "./replace-plan-storyboard-video-video.js";

type TextContent = Array<{ type: string; text: string }>;
type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } };

const PROJECT = "test-proj";
const ANALYSIS_FILENAME = ".original.analysis.json";
const DEFAULT_ANALYSIS: StoryboardVideoSourceAnalysis = {
  prompt: "A cinematic source image with a person in a lived-in room, natural light, visible wardrobe, and a grounded everyday mood.",
  shot: "medium portrait",
  pose: "relaxed standing posture",
};

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function parseSidecar(content: unknown): StoryboardVideoPlanSidecar {
  const parsed = JSON.parse((content as TextContent)[0].text) as { sidecar: StoryboardVideoPlanSidecar };
  return parsed.sidecar;
}

describe("plan_storyboard_video tools", () => {
  let tempDir: string;
  let fs: VideocityFs;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-plan-storyboard-video-test-"));
    fs = createFs({ projectsDir: tempDir });
    unwrap(await fs.createProject(PROJECT));
  });

  afterEach(async () => {
    fs.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createImage(name = "source", analysis: StoryboardVideoSourceAnalysis | null = DEFAULT_ANALYSIS): Promise<string> {
    const asset = unwrap(await fs.createAsset("img", name, PROJECT));
    unwrap(await fs.writeFile(asset.assetId, "original.png", Buffer.from("png"), PROJECT));
    if (analysis) {
      unwrap(await fs.writeFile(asset.assetId, ANALYSIS_FILENAME, JSON.stringify(analysis, null, 2), PROJECT));
    }
    return asset.assetId;
  }

  async function createPlan(sourceId?: string): Promise<StoryboardVideoPlanSidecar> {
    const result = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId ?? (await createImage()),
      storyboard_prompt: "Create a compact storyboard sheet.",
      video_prompt: "Use [Image 1] and [Image 2].",
      duration_s: 12,
    });
    expect(result.isError).toBeFalsy();
    return parseSidecar(result.content);
  }

  it("creates a storyboard-video plan from one image asset", async () => {
    const sourceId = await createImage("banana-reference");
    const sidecar = await createPlan(sourceId);

    expect(sidecar).toMatchObject({
      formula: "storyboard_video",
      source_image_asset_id: sourceId,
      storyboard_brief: "",
      loop_video: false,
      storyboard_prompt: "Create a compact storyboard sheet.",
      video_prompt: "Use [Image 1] and [Image 2].",
      storyboard_asset_id: null,
      video_asset_id: null,
      storyboard_model: "generate_gpt_image",
      video_model: "generate_seedance2_video",
      duration_s: 12,
      aspect_ratio: "16:9",
      resolution: "720p",
      total_duration_s: 12,
    });

    const read = await fs.readFile("plan", ".plan.json", PROJECT);
    expect(read.ok).toBe(true);
  });

  it("rejects a non-image source asset", async () => {
    const video = unwrap(await fs.createAsset("vid", "clip", PROJECT));
    const result = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: video.assetId,
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("source_image_asset_id must be an img-* asset");
  });

  it("defaults the Seedance prompt to ordered image references", async () => {
    const sourceId = await createImage("default-prompt-source");
    const result = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId,
    });

    expect(result.isError).toBeFalsy();
    const sidecar = parseSidecar(result.content);
    expect(sidecar.video_prompt).toContain("Use [Image 1] as the authoritative director-approved storyboard");
    expect(sidecar.video_prompt).toContain("Use [Image 2] as the original source image");
    expect(sidecar.video_prompt).toContain("Do not force the final shot to match the opening shot");
    expect(sidecar.video_prompt).not.toContain("@[storyboard ref]");
  });

  it("builds the default storyboard prompt from source image analysis", async () => {
    const analysis: StoryboardVideoSourceAnalysis = {
      prompt: "A sunlit retro kitchen portrait with teal cabinets, a yellow tied shirt, striped lounge pants, soft film grain, and an easy summer mood.",
      shot: "vertical medium portrait near a kitchen counter",
      pose: "one hand in messy hair, one hand resting on the counter",
    };
    const sourceId = await createImage("analysis-source", analysis);

    const result = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId,
    });

    expect(result.isError).toBeFalsy();
    const sidecar = parseSidecar(result.content);
    expect(sidecar.source_image_analysis).toEqual(analysis);
    expect(sidecar.storyboard_brief).toBe("");
    expect(sidecar.loop_video).toBe(false);
    expect(sidecar.storyboard_prompt).toContain(analysis.prompt);
    expect(sidecar.storyboard_prompt).toContain(analysis.shot);
    expect(sidecar.storyboard_prompt).toContain(analysis.pose);
    expect(sidecar.storyboard_prompt).toContain("User direction: derive the sequence subject and action from the source image analysis.");
    expect(sidecar.storyboard_prompt).toContain("Loop behavior: this does not need to loop");
    expect(sidecar.storyboard_prompt).toContain("must look custom-built from the source image analysis");
    expect(sidecar.storyboard_prompt).not.toContain("BANANA BREAD");
    expect(sidecar.storyboard_prompt).not.toContain("banana peel");
  });

  it("adds user story direction and loop behavior to derived prompts", async () => {
    const sourceId = await createImage("directed-loop-source", {
      prompt: "A confident man in a blue suit standing on a Bangkok sidewalk with skyscrapers, temple details, tuk-tuk traffic, and bright midday light.",
      shot: "full-body street portrait",
      pose: "standing forward with hands in pockets",
    });

    const result = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId,
      storyboard_brief: "A business leader crosses the street, notices a chance meeting, and resets to the opening pose.",
      loop_video: true,
    });

    expect(result.isError).toBeFalsy();
    const sidecar = parseSidecar(result.content);
    expect(sidecar.storyboard_brief).toBe("A business leader crosses the street, notices a chance meeting, and resets to the opening pose.");
    expect(sidecar.loop_video).toBe(true);
    expect(sidecar.storyboard_prompt).toContain("User direction: A business leader crosses the street");
    expect(sidecar.storyboard_prompt).toContain("Loop behavior: design the final panel to visually match the opening panel");
    expect(sidecar.storyboard_prompt).toContain("custom image-derived loopable sequence");
    expect(sidecar.video_prompt).toContain("Make the final shot visually match the opening shot");
    expect(sidecar.video_prompt).not.toContain("@[storyboard ref]");
  });

  it("rebuilds derived prompts when loop behavior changes", async () => {
    const sourceId = await createImage("loop-update-source");

    const first = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId,
      storyboard_brief: "A calm sidewalk portrait turns into a confident city walk.",
      loop_video: false,
    });
    expect(first.isError).toBeFalsy();
    const firstSidecar = parseSidecar(first.content);

    const second = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId,
      storyboard_brief: "A calm sidewalk portrait turns into a confident city walk.",
      loop_video: true,
    });

    expect(second.isError).toBeFalsy();
    const secondSidecar = parseSidecar(second.content);
    expect(secondSidecar.storyboard_prompt).not.toBe(firstSidecar.storyboard_prompt);
    expect(secondSidecar.storyboard_prompt).toContain("final panel to visually match the opening panel");
    expect(secondSidecar.video_prompt).toContain("Make the final shot visually match the opening shot");
  });

  it("persists a generated storyboard and clears the prior video", async () => {
    await createPlan();
    const storyboard = await createImage("storyboard");
    const staleVideo = unwrap(await fs.createAsset("vid", "stale", PROJECT));
    const videoResult = await replacePlanStoryboardVideoVideoDef(fs).handler({
      project_slug: PROJECT,
      asset_id: staleVideo.assetId,
    });
    expect(videoResult.isError).toBeFalsy();

    const result = await replacePlanStoryboardVideoStoryboardDef(fs).handler({
      project_slug: PROJECT,
      asset_id: storyboard,
    });

    expect(result.isError).toBeFalsy();
    const sidecar = parseSidecar(result.content);
    expect(sidecar.storyboard_asset_id).toBe(storyboard);
    expect(sidecar.video_asset_id).toBeNull();
  });

  it("persists a generated video", async () => {
    await createPlan();
    const video = unwrap(await fs.createAsset("vid", "rendered", PROJECT));

    const result = await replacePlanStoryboardVideoVideoDef(fs).handler({
      project_slug: PROJECT,
      asset_id: video.assetId,
    });

    expect(result.isError).toBeFalsy();
    const sidecar = parseSidecar(result.content);
    expect(sidecar.video_asset_id).toBe(video.assetId);
  });

  it("rejects wrong asset prefixes in replacement tools", async () => {
    await createPlan();
    const image = await createImage("not-video");
    const video = unwrap(await fs.createAsset("vid", "not-storyboard", PROJECT));

    const storyboardResult = await replacePlanStoryboardVideoStoryboardDef(fs).handler({
      project_slug: PROJECT,
      asset_id: video.assetId,
    });
    const videoResult = await replacePlanStoryboardVideoVideoDef(fs).handler({
      project_slug: PROJECT,
      asset_id: image,
    });

    expect(storyboardResult.isError).toBe(true);
    expect(videoResult.isError).toBe(true);
    expect((storyboardResult.content as TextContent)[0].text).toContain("img-*");
    expect((videoResult.content as TextContent)[0].text).toContain("vid-*");
  });
});
