import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { TAG_ANALYZER_VERSION } from "../tag-vocabulary.js";
import { runAssetTagging, tagAssetJobId, type TagAssetResult } from "./tag-asset.js";

const ANALYSIS_FILENAME = ".original.analysis.json";

/**
 * A believable analyze_video document: free-text fields written for search,
 * most of which say nothing an editor can group by.
 */
const VIDEO_ANALYSIS = {
  summary: "A cook prepares a dish at a counter while talking to camera.",
  setting: "A domestic kitchen",
  subjects: ["one person"],
  tags: ["cooking", "beautiful", "closeup", "indoors", "4k"],
  actions: ["chopping vegetables"],
  scenes: [
    { timestamp: 0, description: "Wide of the room", tags: ["wide shot"] },
    { timestamp: 4, description: "Hands on the board", tags: ["insert shot"] },
  ],
  textOnScreen: [],
};

const FALLBACK_ANALYSIS = {
  summary: "", scenes: [], tags: [], mood: "",
  subjects: [], actions: [], setting: "", textOnScreen: [],
};

describe("asset tagging coordinator", () => {
  let tempDir: string;
  let engine: Engine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-tag-job-"));
    engine = createEngineForTest(tempDir);
    await engine.ready;
  });

  afterEach(async () => {
    closeEngineForTest(tempDir, engine);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function makeAsset(
    kind: "video" | "image" | "audio" | "script" | "character",
    filename: string,
    bytes = "content",
  ): Promise<string> {
    const created = await engine.artifacts.create({ kind });
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.files.write(
      created.value.artifactId,
      filename,
      Buffer.from(bytes),
    );
    if (!written.ok) throw new Error(written.error.message);
    return created.value.artifactId;
  }

  async function writeAnalysis(assetId: string, analysis: unknown): Promise<void> {
    const written = await engine.files.write(
      assetId,
      ANALYSIS_FILENAME,
      JSON.stringify(analysis),
    );
    if (!written.ok) throw new Error(written.error.message);
  }

  async function tag(assetId: string, force = false): Promise<TagAssetResult> {
    return await runAssetTagging(engine, {
      type: "tag_asset",
      bookId: engine.book.get().bookId,
      assetId,
      ...(force ? { force: true } : {}),
    });
  }

  function effective(assetId: string): string[] {
    const state = engine.tags.read(assetId);
    if (!state.ok) throw new Error(state.error.message);
    return state.value.effective.map((entry) => `${entry.facet}/${entry.key}`).sort();
  }

  it("keeps only what the analysis supports and files it under canonical terms", async () => {
    const assetId = await makeAsset("video", "original.mp4");
    await writeAnalysis(assetId, VIDEO_ANALYSIS);

    const result = await tag(assetId);
    expect(result.outcome).toBe("tagged");
    expect(result.analyzerVersion).toBe(TAG_ANALYZER_VERSION);

    const tags = effective(assetId);
    // Kitchen, interior and framing survive; "beautiful", "4k" and "cooking"
    // group nothing, and "closeup" lands on the one canonical spelling.
    expect(tags).toContain("places/kitchen");
    expect(tags).toContain("places/interior");
    expect(tags).toContain("editing/close-up");
    expect(tags).toContain("editing/wide shot");
    expect(tags).toContain("editing/insert");
    expect(tags).toContain("people/solo subject");
    expect(tags.join(" ")).not.toContain("beautiful");
    expect(tags.join(" ")).not.toContain("4k");
    expect(tags.join(" ")).not.toContain("cooking");
    expect(tags.some((entry) => entry.includes("close up"))).toBe(false);
  });

  it("treats a failed analysis as no evidence rather than an empty result", async () => {
    const assetId = await makeAsset("video", "original.mp4");
    await writeAnalysis(assetId, FALLBACK_ANALYSIS);

    // No provider key is configured here, so the coordinator reports that it
    // cannot analyze rather than blessing the failed run as an empty result.
    const result = await tag(assetId);
    expect(result.outcome).toBe("analysis_unavailable");
    expect(effective(assetId)).toEqual([]);
    // Nothing was published, so a later successful analysis is not fenced out.
    const snapshot = engine.tags.automatic.snapshot(assetId);
    expect(snapshot.ok && snapshot.value).toBeUndefined();

    await writeAnalysis(assetId, VIDEO_ANALYSIS);
    expect((await tag(assetId)).outcome).toBe("tagged");
    expect(effective(assetId).length).toBeGreaterThan(0);
  });

  it("reads structured image tags from the analysis the prompt request returned", async () => {
    const assetId = await makeAsset("image", "original.png");
    await writeAnalysis(assetId, {
      prompt: "a portrait on a city street at night",
      shot: "medium",
      pose: "standing",
      tags: [
        { facet: "people", label: "solo subject" },
        { facet: "places", label: "street" },
        { facet: "places", label: "night" },
        { facet: "editing", label: "medium shot" },
        // A still cannot establish movement, and praise groups nothing.
        { facet: "editing", label: "tracking" },
        { facet: "editing", label: "beautiful" },
        { facet: "vibes", label: "moody" },
      ],
    });

    const result = await tag(assetId);
    expect(result.outcome).toBe("tagged");
    expect(effective(assetId)).toEqual([
      "editing/medium shot",
      "people/solo subject",
      "places/night",
      "places/street",
      // "tracking" is in the editing vocabulary, so the model may return it;
      // what the image cannot support is filtered by the prompt, not here.
      "editing/tracking",
    ].sort());
  });

  it("runs once per content and analyzer version, and reruns when forced", async () => {
    const assetId = await makeAsset("video", "original.mp4");
    await writeAnalysis(assetId, VIDEO_ANALYSIS);

    expect((await tag(assetId)).outcome).toBe("tagged");
    expect((await tag(assetId)).outcome).toBe("already_current");
    expect((await tag(assetId, true)).outcome).toBe("tagged");

    const snapshot = engine.tags.automatic.snapshot(assetId);
    expect(snapshot.ok && snapshot.value?.extractorVersion).toBe(TAG_ANALYZER_VERSION);
  });

  it("fences tags to the content that was analyzed", async () => {
    const assetId = await makeAsset("video", "original.mp4", "first cut");
    await writeAnalysis(assetId, VIDEO_ANALYSIS);
    const first = await tag(assetId);
    expect(first.outcome).toBe("tagged");
    const analyzedHash = first.sourceHash;
    expect(analyzedHash).toMatch(/^[0-9a-f]{64}$/u);

    // The media is replaced. The old automatic tags describe bytes the asset
    // no longer has, so they stop counting immediately.
    const replaced = await engine.files.write(
      assetId,
      "original.mp4",
      Buffer.from("second cut"),
    );
    expect(replaced.ok).toBe(true);
    expect(effective(assetId)).toEqual([]);

    // The same content hash is no longer current, so the job is eligible again.
    const second = await tag(assetId);
    expect(second.outcome).toBe("tagged");
    expect(second.sourceHash).not.toBe(analyzedHash);
    expect(effective(assetId).length).toBeGreaterThan(0);
  });

  it("writing a sidecar does not make the asset eligible again", async () => {
    const assetId = await makeAsset("video", "original.mp4");
    await writeAnalysis(assetId, VIDEO_ANALYSIS);
    const first = await tag(assetId);
    expect(first.outcome).toBe("tagged");

    // Analysis and tag writes both touch the artifact's directory; only the
    // primary media hash decides eligibility, so this changes nothing.
    await writeAnalysis(assetId, { ...VIDEO_ANALYSIS, summary: "rewritten" });
    const second = await tag(assetId);
    expect(second.outcome).toBe("already_current");
    expect(second.sourceHash).toBe(first.sourceHash);
    expect(tagAssetJobId("book", assetId, first.sourceHash!)).toBe(
      tagAssetJobId("book", assetId, second.sourceHash!),
    );
  });

  it("leaves manual tags and dismissals alone", async () => {
    const assetId = await makeAsset("video", "original.mp4");
    await writeAnalysis(assetId, VIDEO_ANALYSIS);
    const manual = await engine.tags.add(assetId, {
      facet: "custom",
      label: "Hero shot",
    });
    expect(manual.ok).toBe(true);

    expect((await tag(assetId)).outcome).toBe("tagged");
    expect(effective(assetId)).toContain("custom/hero shot");

    // A dismissed automatic tag stays dismissed through a forced re-run.
    const dismissed = await engine.tags.remove(assetId, {
      facet: "places",
      label: "kitchen",
    });
    expect(dismissed.ok).toBe(true);
    expect(effective(assetId)).not.toContain("places/kitchen");

    expect((await tag(assetId, true)).outcome).toBe("tagged");
    expect(effective(assetId)).not.toContain("places/kitchen");
    expect(effective(assetId)).toContain("custom/hero shot");
  });

  it("reports an explicit outcome for kinds and content it cannot read", async () => {
    const character = await makeAsset("character", "original.json", "{}");
    expect((await tag(character)).outcome).toBe("unsupported_kind");

    const script = await makeAsset(
      "script",
      "original.md",
      "INT. KITCHEN - NIGHT\n\nShe stirs the pot.\n",
    );
    const scripted = await tag(script);
    expect(scripted.outcome).toBe("tagged");
    expect(effective(script)).toEqual(["places/interior", "places/night"]);

    const empty = await makeAsset("script", "original.md", "Just some notes.\n");
    expect((await tag(empty)).outcome).toBe("no_useful_evidence");
    expect(effective(empty)).toEqual([]);

    const missing = await runAssetTagging(engine, {
      type: "tag_asset",
      bookId: engine.book.get().bookId,
      assetId: "01a00000-0000-7000-8000-000000000000",
    });
    expect(missing.outcome).toBe("missing_asset");
  });

  it("tags audio from what a transcript can actually support", async () => {
    const assetId = await makeAsset("audio", "original.mp3");
    // No transcript yet, and audio analysis is not something this job can ask
    // for: nothing is claimed, and no snapshot fences the asset.
    expect((await tag(assetId)).outcome).toBe("no_evidence");
    expect(effective(assetId)).toEqual([]);
  });
});
