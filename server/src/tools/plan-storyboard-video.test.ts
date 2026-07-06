import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFs } from "videocity-engine";
import type { VideocityFs } from "videocity-engine";
import type { StoryboardVideoPlanSidecar, StoryboardVideoSourceAnalysis } from "../plan-types.js";
import { queue } from "../queue.js";
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
      source_image_asset_ids: [sourceId],
      storyboard_brief: "",
      loop_video: false,
      storyboard_prompt: "Create a compact storyboard sheet.",
      video_prompt: "Use [Image 1] and [Image 2].",
      storyboard_asset_id: null,
      video_asset_id: null,
      storyboard_model: "generate_gpt_image",
      video_model: "generate_seedance2_mini_video",
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
    expect((result.content as TextContent)[0].text).toContain("source_image_asset_ids[0] must be an img-* asset");
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
    expect(sidecar.video_prompt).toContain("Use [Image 2] as the primary source image");
    expect(sidecar.video_prompt).toContain("Do not force the final shot to match the opening shot");
    expect(sidecar.video_prompt).not.toContain("@[storyboard ref]");
  });

  it("falls back to the default Seedance variant when Grok is requested for storyboard video", async () => {
    const sourceId = await createImage("removed-grok-video-source");
    const result = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId,
      video_model: "generate_grok_imagine_video",
    });

    expect(result.isError).toBeFalsy();
    const sidecar = parseSidecar(result.content);
    expect(sidecar.video_model).toBe("generate_seedance2_mini_video");
    expect(sidecar.video_prompt).toContain("Reference images are sent in this exact order");
    expect(sidecar.video_prompt).not.toContain("Grok Imagine 1.5");
  });

  it("defaults to Seedance 2 Mini when no video model is requested", async () => {
    const sourceId = await createImage("default-mini-source");
    const result = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId,
      storyboard_prompt: "Create a compact storyboard sheet.",
      video_prompt: "Use [Image 1] and [Image 2].",
    });

    expect(result.isError).toBeFalsy();
    const sidecar = parseSidecar(result.content);
    expect(sidecar.video_model).toBe("generate_seedance2_mini_video");
  });

  it("round-trips an explicit Seedance 2 Mini video model", async () => {
    const sourceId = await createImage("explicit-mini-source");
    const result = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId,
      video_model: "generate_seedance2_mini_video",
    });

    expect(result.isError).toBeFalsy();
    const sidecar = parseSidecar(result.content);
    expect(sidecar.video_model).toBe("generate_seedance2_mini_video");
  });

  it("preserves an explicit full Seedance 2 video model", async () => {
    const sourceId = await createImage("explicit-ref-source");
    const result = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId,
      video_model: "generate_seedance2_video",
    });

    expect(result.isError).toBeFalsy();
    const sidecar = parseSidecar(result.content);
    expect(sidecar.video_model).toBe("generate_seedance2_video");
  });

  it("migrates stale Grok storyboard plans back to the default Seedance variant", async () => {
    const sourceId = await createImage("stale-grok-source");
    const first = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId,
    });
    expect(first.isError).toBeFalsy();
    const firstSidecar = parseSidecar(first.content);
    expect(firstSidecar.video_model).toBe("generate_seedance2_mini_video");
    unwrap(await fs.writeFile("plan", ".plan.json", JSON.stringify({
      ...firstSidecar,
      video_model: "generate_grok_imagine_video",
      video_prompt: `Use [Image 1] as the only visual reference image. [Image 1] is a single concatenated reference sheet for Grok Imagine 1.5.

[LOOP REQUIREMENT]
End on a clean final beat.`,
      video_asset_id: "vid-stale-grok",
    }, null, 2), PROJECT));

    const second = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId,
    });

    expect(second.isError).toBeFalsy();
    const secondSidecar = parseSidecar(second.content);
    expect(secondSidecar.video_model).toBe("generate_seedance2_mini_video");
    expect(secondSidecar.video_prompt).toContain("Reference images are sent in this exact order");
    expect(secondSidecar.video_prompt).not.toContain("Grok Imagine 1.5");
    expect(secondSidecar.video_asset_id).toBeNull();
  });

  it("creates a storyboard-video plan from multiple source image assets", async () => {
    const primary = await createImage("primary-source");
    const wardrobe = await createImage("wardrobe-source");
    const setting = await createImage("setting-source");

    const result = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_ids: [`@${primary}`, `@${wardrobe}`, `@${setting}`, `@${primary}`],
      storyboard_brief: "Use the first image as the hero and borrow outfit and setting details from the other references.",
    });

    expect(result.isError).toBeFalsy();
    const sidecar = parseSidecar(result.content);
    expect(sidecar.source_image_asset_id).toBe(primary);
    expect(sidecar.source_image_asset_ids).toEqual([primary, wardrobe, setting]);
    expect(sidecar.storyboard_prompt).toContain("Use the first image as the hero");
    expect(sidecar.video_prompt).toContain("Use [Image 3] through [Image 4] as additional source image references");
    expect(sidecar.video_prompt).toContain("[Image 2] is the primary source image");
    expect(sidecar.storyboard_asset_id).toBeNull();
    expect(sidecar.video_asset_id).toBeNull();
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

  it("adapts hostile quoted direction in derived storyboard prompts", async () => {
    const sourceId = await createImage("adapted-direction-source", {
      prompt: "A smiling man in a blue suit stands in front of the Eiffel Tower on a bright tourist walkway.",
      shot: "full-body tourist portrait",
      pose: "standing forward with hands in pockets",
    });
    const brief = "man sees a scammer selling fake effiel towers, exposes him by saying \"it's a scam\" and then tells the scammer to \"go back to where you came from\"";

    const result = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId,
      storyboard_brief: brief,
      loop_video: true,
    });

    expect(result.isError).toBeFalsy();
    const sidecar = parseSidecar(result.content);
    expect(sidecar.storyboard_brief).toBe(brief);
    expect(sidecar.storyboard_prompt).toContain("User direction, adapted for visual storytelling");
    expect(sidecar.storyboard_prompt).toContain("counterfeit Eiffel Tower souvenirs");
    expect(sidecar.storyboard_prompt).toContain("move along");
    expect(sidecar.storyboard_prompt).not.toContain("\"it's a scam\"");
    expect(sidecar.storyboard_prompt).not.toContain("\"pack it up");
    expect(sidecar.storyboard_prompt).not.toContain("go back to where you came from");
    expect(sidecar.storyboard_prompt.length).toBeLessThan(5000);
  });

  it("rebuilds derived prompts for the same source when requested", async () => {
    const sourceId = await createImage("rebuild-source");
    const initial = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId,
      storyboard_brief: "A calm portrait becomes a short city walk.",
      storyboard_prompt: "Old custom storyboard prompt.",
      video_prompt: "Old custom video prompt.",
    });
    expect(initial.isError).toBeFalsy();
    const storyboard = await createImage("old-storyboard");
    const storyboardResult = await replacePlanStoryboardVideoStoryboardDef(fs).handler({
      project_slug: PROJECT,
      asset_id: storyboard,
    });
    expect(storyboardResult.isError).toBeFalsy();

    const rebuilt = await planStoryboardVideoDef(fs).handler({
      project_slug: PROJECT,
      source_image_asset_id: sourceId,
      storyboard_brief: "A calm portrait becomes a short city walk.",
      rebuild_prompts: true,
    });

    expect(rebuilt.isError).toBeFalsy();
    const sidecar = parseSidecar(rebuilt.content);
    expect(sidecar.storyboard_prompt).not.toBe("Old custom storyboard prompt.");
    expect(sidecar.storyboard_prompt).toContain(DEFAULT_ANALYSIS.prompt);
    expect(sidecar.video_prompt).toContain("Use [Image 1] as the authoritative director-approved storyboard");
    expect(sidecar.storyboard_asset_id).toBeNull();
    expect(sidecar.video_asset_id).toBeNull();
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

  it("auto-enqueues a GPT Image 2 storyboard sheet when the plan is created with KIE_API_KEY", async () => {
    process.env.KIE_API_KEY = "test-key";
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    try {
      const sourceId = await createImage("auto-storyboard-source");
      const result = await planStoryboardVideoDef(fs).handler({
        project_slug: PROJECT,
        source_image_asset_id: sourceId,
      });

      expect(result.isError).toBeFalsy();
      const sidecar = parseSidecar(result.content);
      expect(sidecar.storyboard_asset_id).toBeTruthy();
      expect(sidecar.storyboard_asset_id).toMatch(/^img-/);
      expect(enqueue).toHaveBeenCalledTimes(1);
      const payload = enqueue.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.type).toBe("generate_gpt_image");
      expect(payload.prompt).toBe(sidecar.storyboard_prompt);
      expect(payload.aspectRatio).toBe("16:9");
      expect(payload.resolution).toBe("2K");
      expect(payload.projectSlug).toBe(PROJECT);
      const manifest = await fs.getManifest(sidecar.storyboard_asset_id as string, PROJECT);
      expect(manifest.ok).toBe(true);
    } finally {
      delete process.env.KIE_API_KEY;
      vi.restoreAllMocks();
    }
  });

  it("does not auto-generate the storyboard when KIE_API_KEY is unset", async () => {
    delete process.env.KIE_API_KEY;
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    try {
      const sourceId = await createImage("no-auto-storyboard-source");
      const result = await planStoryboardVideoDef(fs).handler({
        project_slug: PROJECT,
        source_image_asset_id: sourceId,
      });

      expect(result.isError).toBeFalsy();
      const sidecar = parseSidecar(result.content);
      expect(sidecar.storyboard_asset_id).toBeNull();
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not re-enqueue when a storyboard asset is already kept", async () => {
    process.env.KIE_API_KEY = "test-key";
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    try {
      const sourceId = await createImage("kept-storyboard-source");
      const first = await planStoryboardVideoDef(fs).handler({
        project_slug: PROJECT,
        source_image_asset_id: sourceId,
      });
      expect(first.isError).toBeFalsy();
      expect(enqueue).toHaveBeenCalledTimes(1);
      const firstSidecar = parseSidecar(first.content);
      expect(firstSidecar.storyboard_asset_id).toBeTruthy();

      const second = await planStoryboardVideoDef(fs).handler({
        project_slug: PROJECT,
        source_image_asset_id: sourceId,
      });

      expect(second.isError).toBeFalsy();
      const secondSidecar = parseSidecar(second.content);
      expect(secondSidecar.storyboard_asset_id).toBe(firstSidecar.storyboard_asset_id);
      expect(enqueue).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.KIE_API_KEY;
      vi.restoreAllMocks();
    }
  });
});
