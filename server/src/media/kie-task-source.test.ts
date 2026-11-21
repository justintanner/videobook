import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import { getAllToolDefs } from "../tools/index.js";
import { resolveModel } from "./descriptor.js";
import { buildWireRequest } from "./request.js";
import { kieTaskSourceCostHints, kieTaskSourceError } from "./kie-task-source.js";

const DRAFT_COMPLETE = "kie:bytedance/seedance-2-5-draft";
const GEMINI_EXTEND = "kie:google/gemini-omni-flash-1-2-extend";

describe("Seedance 2.5 draft completion", () => {
  let rootDir: string;
  let engine: Engine;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "seedance-draft-"));
    engine = createEngine({ rootDir, initialBookName: "draft-costs", durableWrites: false });
    await engine.ready;
  });

  afterEach(async () => {
    engine.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  async function draft(taskId: string, payload: Record<string, unknown>, metadata: Record<string, unknown> = {}): Promise<string> {
    const created = await engine.artifacts.create("video", "seedance draft");
    if (!created.ok) throw new Error(created.error.message);
    const { artifactId } = created.value;
    for (const [key, value] of Object.entries({ "kie-task-id": { taskId }, "generation-payload": payload, ...metadata })) {
      expect((await engine.metadata.artifacts.write(artifactId, key, value)).ok).toBe(true);
    }
    return artifactId;
  }

  async function estimate(options: Record<string, unknown>, model = DRAFT_COMPLETE, prompt?: string): Promise<{ usd: number; warnings: string[] }> {
    const tool = getAllToolDefs(engine).find((definition) => definition.name === "estimate_cost")!;
    const result = await tool.handler({ calls: [{ tool_name: "generate_video", input: { model, options, ...(prompt ? { prompt } : {}) } }] });
    expect(result.isError).not.toBe(true);
    return (JSON.parse(result.content[0]!.text!) as { estimate: { usd: number; warnings: string[] } }).estimate;
  }

  it("is a picker model that only needs the draft's Kie task id", () => {
    const model = resolveModel(DRAFT_COMPLETE);
    expect(model).toMatchObject({ provider: "kie", media: "video", title: "Seedance 2.5 Draft Complete", promptField: null, slots: [] });
    expect(model.entry).toMatchObject({ operations: ["upscale_video"] });
    expect(model.entry.hidden).toBeUndefined();
    expect(model.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "draft_task_id", required: true }),
      expect.objectContaining({ name: "resolution", enumValues: ["1080p"], defaultValue: "1080p", required: false }),
    ]));
    expect(buildWireRequest(model, { options: { draft_task_id: "kie-draft-1" } })).toMatchObject({
      ok: true,
      request: { model: "bytedance/seedance-2-5-draft", input: { draft_task_id: "kie-draft-1", resolution: "1080p" } },
    });
    expect(buildWireRequest(model, {})).toMatchObject({ ok: false, error: expect.stringContaining("Draft task id") });
  });

  it("bills the final from the requested seconds of a draft rendered in this book", async () => {
    await draft("kie-draft-1", { model: "bytedance/seedance-2-5", input: { prompt: "a boat", draft: true, resolution: "480p", duration: 6 } });
    expect(await kieTaskSourceCostHints(engine, DRAFT_COMPLETE, { draft_task_id: " kie-draft-1 " }))
      .toEqual({ durationSeconds: 6, inputDurationSeconds: 0 });
    expect((await estimate({ draft_task_id: "kie-draft-1" })).usd).toBeCloseTo(6 * 0.79, 6);
  });

  it("uses the generated length and recorded reference video seconds of a smart-duration draft", async () => {
    await draft("kie-draft-2", {
      model: "bytedance/seedance-2-5",
      input: { draft: true, resolution: "480p", duration: -1, reference_video_urls: ["https://example.test/clip.mp4"] },
    }, { original: { duration: 7.4 }, "generation-cost-hints": { inputDurationSeconds: 5 } });
    expect(await kieTaskSourceCostHints(engine, DRAFT_COMPLETE, { draft_task_id: "kie-draft-2" }))
      .toEqual({ durationSeconds: 7, inputDurationSeconds: 5 });
    expect((await estimate({ draft_task_id: "kie-draft-2" })).usd).toBeCloseTo(12 * 0.475, 6);
  });

  it("leaves the final unpriced when the draft is unknown or was not a draft", async () => {
    await draft("kie-final", { model: "bytedance/seedance-2-5", input: { draft: false, resolution: "1080p", duration: 6 } });
    await draft("kie-unmeasured", { model: "bytedance/seedance-2-5", input: { draft: true, duration: 6, reference_video_urls: ["https://example.test/clip.mp4"] } });
    expect(await kieTaskSourceCostHints(engine, DRAFT_COMPLETE, { draft_task_id: "kie-final" })).toEqual({});
    expect(await kieTaskSourceCostHints(engine, DRAFT_COMPLETE, { draft_task_id: "elsewhere" })).toEqual({});
    expect(await kieTaskSourceCostHints(engine, "kie:bytedance/seedance-2-5", { draft_task_id: "kie-final" })).toEqual({});
    expect(await kieTaskSourceCostHints(engine, DRAFT_COMPLETE, { draft_task_id: "kie-unmeasured" })).toEqual({ durationSeconds: 6 });
    expect(await estimate({ draft_task_id: "elsewhere" })).toMatchObject({ usd: 0, warnings: [expect.stringContaining("draft_task_id")] });
  });

  it("prices a Gemini Omni 1.2 Flash extend at the resolution of the Kie task it extends", async () => {
    const model = resolveModel(GEMINI_EXTEND);
    expect(model.entry).toMatchObject({ operations: ["extend_video"] });
    expect(model.slots).toEqual([expect.objectContaining({ role: "image", field: "image_urls", min: 0, max: 3 })]);
    expect(buildWireRequest(model, { prompt: "the fox jumps the fence", options: { task_id: "kie-omni-1", duration: 5 } })).toMatchObject({
      ok: true,
      request: { model: "google/gemini-omni-flash-1-2-extend", input: { task_id: "kie-omni-1", prompt: "the fox jumps the fence", duration: 5 } },
    });
    expect(buildWireRequest(model, { prompt: "x", options: { task_id: "kie-omni-1", duration: 11 } })).toMatchObject({ ok: false });
    await draft("kie-omni-1", { model: "google/gemini-omni-flash-1-2", input: { prompt: "a fox", resolution: "360p", duration: 8 } });
    await draft("kie-omni-2", { model: "google/gemini-omni-flash-1-2-extend", input: { task_id: "kie-omni-1", prompt: "on", duration: 3 } },
      { "generation-cost-hints": { inputResolution: "360p" } });
    await draft("kie-omni-hd", { model: "google/gemini-omni-flash-1-2", input: { prompt: "a fox", resolution: "1080p" } });
    expect(await kieTaskSourceCostHints(engine, GEMINI_EXTEND, { task_id: " kie-omni-1 " })).toEqual({ inputResolution: "360p" });
    expect(await kieTaskSourceCostHints(engine, GEMINI_EXTEND, { task_id: "kie-omni-2" })).toEqual({ inputResolution: "360p" });
    expect(await kieTaskSourceCostHints(engine, GEMINI_EXTEND, { task_id: "kie-omni-hd" })).toEqual({});
    expect(await kieTaskSourceCostHints(engine, GEMINI_EXTEND, { task_id: "elsewhere" })).toEqual({});
    expect((await estimate({ task_id: "kie-omni-2", duration: 5 }, GEMINI_EXTEND, "on")).usd).toBeCloseTo(5 * 0.02, 6);
    expect(await estimate({ task_id: "elsewhere", duration: 5 }, GEMINI_EXTEND, "on"))
      .toMatchObject({ usd: 0, warnings: [expect.stringContaining("inputResolution")] });
  });

  it("refuses to extend a 1080p, 4k, over-15 s, unfinished or non-Omni source before calling Kie", async () => {
    const omni = (input: Record<string, unknown>) => ({ model: "google/gemini-omni-flash-1-2", input: { prompt: "a fox", ...input } });
    await draft("kie-omni-720", omni({ resolution: "720p", duration: 15 }), { original: { duration: 15.04 } });
    await draft("kie-omni-1080", omni({ resolution: "1080p", duration: 8 }));
    await draft("kie-omni-4k", omni({ resolution: "4k", duration: 8 }));
    await draft("kie-omni-long", omni({ resolution: "360p" }), { original: { duration: 16.2 } });
    await draft("kie-extend-ok", { model: "google/gemini-omni-flash-1-2-extend", input: { task_id: "kie-omni-720", duration: 3 } },
      { "generation-cost-hints": { inputResolution: "720p" }, original: { duration: 14.96 } });
    await draft("kie-extend-long", { model: "google/gemini-omni-flash-1-2-extend", input: { task_id: "kie-omni-720", duration: 10 } },
      { "generation-cost-hints": { inputResolution: "720p" }, original: { duration: 25.01 } });
    await draft("kie-seedance", { model: "bytedance/seedance-2-5", input: { prompt: "a boat", resolution: "720p", duration: 6 } });
    const running = await draft("kie-omni-running", omni({ resolution: "360p", duration: 8 }));
    const lease = await engine.jobs.artifactWork.begin(running, { kind: "generate", ownerKind: "job", durationMs: 60_000 });
    if (!lease) throw new Error("artifactWork.begin failed");
    const pending = await engine.jobs.pending.write({ artifactId: running, taskId: "kie-omni-running", taskType: "media_kie" }, lease.ownerId);
    expect(pending.ok && pending.value).toBeTruthy();

    const refusal = (taskId: string) => kieTaskSourceError(engine, GEMINI_EXTEND, { task_id: taskId });
    expect(await refusal("kie-omni-720")).toBeNull();
    expect(await refusal(" kie-extend-ok ")).toBeNull();
    expect(await refusal("elsewhere")).toBeNull();
    expect(await kieTaskSourceError(engine, "kie:google/gemini-omni-flash-1-2", { task_id: "kie-omni-1080" })).toBeNull();
    expect(await refusal("kie-omni-1080")).toBe("The video of Kie task kie-omni-1080 is 1080p; Gemini Omni 1.2 Flash Extend takes only a 360p or 720p Gemini Omni 1.2 Flash video of at most 15 s that Kie generated in this book");
    expect(await refusal("kie-omni-4k")).toContain("kie-omni-4k is 4k;");
    expect(await refusal("kie-omni-long")).toContain("kie-omni-long is 16 s long;");
    expect(await refusal("kie-extend-long")).toContain("kie-extend-long is 25 s long;");
    expect(await refusal("kie-seedance")).toContain("kie-seedance is a bytedance/seedance-2-5 video;");
    expect(await refusal("kie-omni-running")).toContain("kie-omni-running is still generating; wait for it to finish;");

    expect(await estimate({ task_id: "kie-omni-1080", duration: 5 }, GEMINI_EXTEND, "on"))
      .toMatchObject({ usd: 0, warnings: [expect.stringContaining("kie-omni-1080 is 1080p")] });
    const saved = process.env.KIE_API_KEY;
    process.env.KIE_API_KEY = "local-kie-key";
    try {
      const generate = getAllToolDefs(engine).find((definition) => definition.name === "generate_video")!;
      const before = engine.artifacts.list().length;
      const result = await generate.handler({ model: GEMINI_EXTEND, prompt: "on", options: { task_id: "kie-omni-4k", duration: 5 } });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("kie-omni-4k is 4k");
      expect(engine.artifacts.list()).toHaveLength(before);
    } finally {
      if (saved === undefined) delete process.env.KIE_API_KEY;
      else process.env.KIE_API_KEY = saved;
    }
  });
});
