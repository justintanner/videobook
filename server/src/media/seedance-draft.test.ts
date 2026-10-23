import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import { getAllToolDefs } from "../tools/index.js";
import { resolveModel } from "./descriptor.js";
import { buildWireRequest } from "./request.js";
import { seedanceDraftCostHints } from "./seedance-draft.js";

const DRAFT_COMPLETE = "kie:bytedance/seedance-2-5-draft";

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

  async function estimate(options: Record<string, unknown>): Promise<{ usd: number; warnings: string[] }> {
    const tool = getAllToolDefs(engine).find((definition) => definition.name === "estimate_cost")!;
    const result = await tool.handler({ calls: [{ tool_name: "generate_video", input: { model: DRAFT_COMPLETE, options } }] });
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
    expect(await seedanceDraftCostHints(engine, DRAFT_COMPLETE, { draft_task_id: " kie-draft-1 " }))
      .toEqual({ durationSeconds: 6, inputDurationSeconds: 0 });
    expect((await estimate({ draft_task_id: "kie-draft-1" })).usd).toBeCloseTo(6 * 0.79, 6);
  });

  it("uses the generated length and recorded reference video seconds of a smart-duration draft", async () => {
    await draft("kie-draft-2", {
      model: "bytedance/seedance-2-5",
      input: { draft: true, resolution: "480p", duration: -1, reference_video_urls: ["https://example.test/clip.mp4"] },
    }, { original: { duration: 7.4 }, "generation-cost-hints": { inputDurationSeconds: 5 } });
    expect(await seedanceDraftCostHints(engine, DRAFT_COMPLETE, { draft_task_id: "kie-draft-2" }))
      .toEqual({ durationSeconds: 7, inputDurationSeconds: 5 });
    expect((await estimate({ draft_task_id: "kie-draft-2" })).usd).toBeCloseTo(12 * 0.475, 6);
  });

  it("leaves the final unpriced when the draft is unknown or was not a draft", async () => {
    await draft("kie-final", { model: "bytedance/seedance-2-5", input: { draft: false, resolution: "1080p", duration: 6 } });
    await draft("kie-unmeasured", { model: "bytedance/seedance-2-5", input: { draft: true, duration: 6, reference_video_urls: ["https://example.test/clip.mp4"] } });
    expect(await seedanceDraftCostHints(engine, DRAFT_COMPLETE, { draft_task_id: "kie-final" })).toEqual({});
    expect(await seedanceDraftCostHints(engine, DRAFT_COMPLETE, { draft_task_id: "elsewhere" })).toEqual({});
    expect(await seedanceDraftCostHints(engine, "kie:bytedance/seedance-2-5", { draft_task_id: "kie-final" })).toEqual({});
    expect(await seedanceDraftCostHints(engine, DRAFT_COMPLETE, { draft_task_id: "kie-unmeasured" })).toEqual({ durationSeconds: 6 });
    expect(await estimate({ draft_task_id: "elsewhere" })).toMatchObject({ usd: 0, warnings: [expect.stringContaining("draft_task_id")] });
  });
});
