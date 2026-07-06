import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFsForTest } from "../fs.js";
import { readClipShowPlan, writeClipShowPlan } from "../plan-clip-show.js";
import type { ClipShowPlanSidecar } from "../plan-types.js";
import { replacePlanClipShowAssetDef } from "./replace-plan-clip-show-asset.js";

function sidecar(): ClipShowPlanSidecar {
  return {
    formula: "clip_show",
    character: {
      asset_id: "char-host",
      name: "Host",
      description: "Host",
      elevenlabs_voice_id: "voice-1",
    },
    show_brief: "",
    tone: "sharp",
    model: "gpt-5.5",
    image_model: "generate_nano_banana_pro_fal",
    audio_model: "elevenlabs",
    segments: [{
      source_image_asset_ids: ["img-source"],
      source_summary: "source",
      joke: "Existing joke",
      joke_type: "deadpan",
      osgs: [{
        source: "upload",
        image_asset_id: "img-source",
        image_prompt: null,
        treatment: "photo",
        beat_text: "beat",
        caption: null,
        duration_ms: 1000,
      }],
      audio_asset_id: null,
    }],
  };
}

describe("replace_plan_clip_show_asset", () => {
  let tempDir: string;
  const projectSlug = "clip-show-add-joke";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-clip-show-tool-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("adds an editable joke at the requested position", async () => {
    const fs = createFsForTest(tempDir);
    await fs.createProject(projectSlug);
    await writeClipShowPlan(fs, projectSlug, sidecar());

    const result = await replacePlanClipShowAssetDef(fs).handler({
      project_slug: projectSlug,
      op: "add_joke",
      segment_index: 1,
    });

    expect(result.isError).toBeFalsy();
    const updated = await readClipShowPlan(fs, projectSlug);
    expect(updated.segments).toHaveLength(2);
    expect(updated.segments[1]).toMatchObject({
      joke: "",
      joke_type: "deadpan",
      source_image_asset_ids: ["img-source"],
      audio_asset_id: null,
    });
    expect(updated.segments[1].osgs).toHaveLength(1);
  });
});
