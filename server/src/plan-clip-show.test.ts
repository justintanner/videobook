import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFsForTest } from "./fs.js";
import { writeClipShowPlan, readClipShowPlan } from "./plan-clip-show.js";
import type { ClipShowPlanSidecar } from "./plan-types.js";

function sampleSidecar(): ClipShowPlanSidecar {
  return {
    formula: "clip_show",
    character: {
      asset_id: "char-host",
      name: "Host",
      description: "a host",
      elevenlabs_voice_id: "voice-1",
    },
    show_brief: "",
    tone: "sharp",
    model: "gpt-5.5",
    image_model: "generate_nano_banana_pro_fal",
    audio_model: "elevenlabs",
    segments: [
      {
        source_image_asset_ids: ["img-1"],
        source_summary: "a thing",
        joke: "a joke",
        joke_type: "auto",
        osgs: [
          {
            source: "upload",
            image_asset_id: "img-1",
            image_prompt: null,
            treatment: "photo",
            beat_text: "beat",
            caption: null,
            duration_ms: 1000,
          },
        ],
        audio_asset_id: null,
      },
    ],
  };
}

describe("writeClipShowPlan", () => {
  let tempDir: string;
  const slug = "clip-show-test";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-csplan-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  // Regression: the engine commits each write scoped to its file path, and a
  // scoped commit with no diff fails (git exits non-zero) when the repo is
  // otherwise dirty — which routine asset work makes it. An idempotent plan edit
  // (e.g. "set joke" with unchanged text before generating a voiceover) must be
  // a graceful no-op, not a thrown "Failed to commit file write".
  it("re-writing an identical plan while the repo is dirty does not throw", async () => {
    const fs = createFsForTest(tempDir);
    const created = await fs.createProject(slug);
    expect(created.ok).toBe(true);

    const sidecar = sampleSidecar();
    await writeClipShowPlan(fs, slug, sidecar); // first write commits the new files

    // Leave an uncommitted file so a scoped no-op commit would otherwise fail.
    await writeFile(join(tempDir, slug, "stray-dirty.txt"), "uncommitted");

    await expect(writeClipShowPlan(fs, slug, sidecar)).resolves.toBeUndefined();

    const read = await readClipShowPlan(fs, slug);
    expect(read.segments[0].joke).toBe("a joke");
  });

  it("writing a changed plan persists the change even with a dirty repo", async () => {
    const fs = createFsForTest(tempDir);
    await fs.createProject(slug);

    const sidecar = sampleSidecar();
    await writeClipShowPlan(fs, slug, sidecar);

    await writeFile(join(tempDir, slug, "stray-dirty.txt"), "uncommitted");
    const changed: ClipShowPlanSidecar = {
      ...sidecar,
      segments: [{ ...sidecar.segments[0], joke: "a better joke" }],
    };
    await writeClipShowPlan(fs, slug, changed);

    const read = await readClipShowPlan(fs, slug);
    expect(read.segments[0].joke).toBe("a better joke");
  });
});
