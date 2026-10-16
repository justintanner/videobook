import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z, type ZodRawShape } from "zod";
import {
  CHAIN_TOOL_CATALOG,
  chainApproveInputSchema,
  chainCancelInputSchema,
  chainPlanFingerprint,
  chainStatusInputSchema,
  chainStepSchema,
  ensureChainStepIds,
  isChainRef,
  planStackedChainFromQuery,
  preflightChainPlan,
  readChainParam,
  substituteChainRefs,
  supportedChainTool,
  writeChainParam,
  type ChainPreflightContext,
  type ChainStep,
} from "./chain-plan.js";
import { closeEngineForTest, createEngineForTest } from "./engine.js";
import { AUTO_APPLY_TOOL_NAMES, effectForTool } from "./chat-router.js";
import { getAllToolDefs } from "./tools/index.js";

const UUID_A = "019fcc00-0000-7000-8000-0000000000a1";
const UUID_B = "019fcc00-0000-7000-8000-0000000000b2";

function extractReplaceSteps(): ChainStep[] {
  return [
    {
      id: "extract",
      tool: "extract_audio",
      params: { asset_id: "@b2" },
    },
    {
      id: "replace",
      tool: "replace_video_audio",
      params: {
        asset_id: "@c4",
        audio_asset_id: {
          $ref: { step_id: "extract", output: "audio_asset_id" },
        },
      },
    },
  ];
}

describe("chain catalog and refs", () => {
  it("exposes extract, replace, and a third local media tool", () => {
    expect(supportedChainTool("extract_audio")?.completion).toBe("extract_audio");
    expect(supportedChainTool("replace_video_audio")?.completion)
      .toBe("replace_video_audio");
    expect(supportedChainTool("trim_video")?.completion).toBe("trim_video");
    expect(supportedChainTool("extract_frame")?.outputs.image_asset_id)
      .toBe("artifact");
    expect(supportedChainTool("chain")).toBeNull();
    expect(supportedChainTool("chat")).toBeNull();
    expect(Object.keys(CHAIN_TOOL_CATALOG).length).toBeGreaterThan(2);
  });

  it("lets generation be chained, carrying how its output reaches the grid", () => {
    const video = supportedChainTool("generate_video");
    expect(video?.completion).toBe("generation");
    expect(video?.placement).toBe("generate_video");
    expect(video?.artifactOutput).toBe("asset_id");
    expect(video?.gridFields).toContain("refs.first_frame");
    expect(video?.gridFields).toContain("refs.image");
    expect(video?.gridFields).toContain("replace_audio_with");
    const image = supportedChainTool("generate_image");
    expect(image?.placement).toBe("generate_image");
    expect(image?.artifactOutput).toBe("asset_id");
    expect(image?.gridFields).toEqual(["refs.image"]);
    expect(supportedChainTool("generate_kie_seedance_2_5_video")).toBeNull();
  });

  it("reads and writes nested chain params by dotted path", () => {
    const params = { prompt: "go", refs: { image: ["@a1"] } };
    expect(readChainParam(params, "refs.image")).toEqual(["@a1"]);
    expect(readChainParam(params, "refs.video")).toBeUndefined();
    expect(readChainParam(params, "prompt.length")).toBeUndefined();
    const written = writeChainParam(params, "refs.first_frame", "@b2");
    expect(written).toEqual({ prompt: "go", refs: { image: ["@a1"], first_frame: "@b2" } });
    expect(params.refs).toEqual({ image: ["@a1"] });
    expect(writeChainParam({}, "replace_audio_with", "@c1")).toEqual({ replace_audio_with: "@c1" });
  });

  it("substitutes structured $ref values and never interpolates strings", () => {
    const outputs = new Map([
      ["extract", { audio_asset_id: UUID_A, job_id: "job-1" }],
    ]);
    expect(substituteChainRefs({
      asset_id: UUID_B,
      audio_asset_id: {
        $ref: { step_id: "extract", output: "audio_asset_id" },
      },
      note: "{$ref:{step_id:extract,output:audio_asset_id}}",
    }, outputs)).toEqual({
      asset_id: UUID_B,
      audio_asset_id: UUID_A,
      note: "{$ref:{step_id:extract,output:audio_asset_id}}",
    });
    expect(isChainRef({
      $ref: { step_id: "extract", output: "audio_asset_id" },
    })).toBe(true);
    expect(isChainRef("{$ref:{step_id:extract,output:audio_asset_id}}")).toBe(false);
  });

  it("fingerprints equivalent plans the same way", () => {
    const steps = extractReplaceSteps();
    expect(chainPlanFingerprint({ version: 1, notebookId: "nb", steps }))
      .toBe(chainPlanFingerprint({ version: 1, notebookId: "nb", steps }));
    expect(chainPlanFingerprint({ version: 1, notebookId: "nb", steps }))
      .not.toBe(chainPlanFingerprint({
        version: 1,
        notebookId: "other",
        steps,
      }));
  });
});

describe("ensureChainStepIds", () => {
  it("fills the ids a router omits and points refs at those steps", () => {
    const steps = ensureChainStepIds([
      { tool: "extract_audio", params: { asset_id: "@b2" } },
      {
        tool: "replace_video_audio",
        params: {
          asset_id: "@c4",
          audio_asset_id: {
            $ref: { step_id: "extract_audio", output: "audio_asset_id" },
          },
        },
      },
    ]);
    expect(z.array(chainStepSchema).safeParse(steps).success).toBe(true);
    expect(steps).toEqual([
      {
        id: "extract_audio",
        tool: "extract_audio",
        params: { asset_id: "@b2" },
      },
      {
        id: "replace_video_audio",
        tool: "replace_video_audio",
        params: {
          asset_id: "@c4",
          audio_asset_id: {
            $ref: { step_id: "extract_audio", output: "audio_asset_id" },
          },
        },
      },
    ]);
  });

  it("keeps explicit ids and rewrites a numeric ref onto the earlier step", () => {
    const steps = ensureChainStepIds([
      { id: "extract", tool: "extract_audio", params: { asset_id: "@b2" } },
      {
        id: "replace",
        tool: "replace_video_audio",
        params: {
          asset_id: "@c4",
          audio_asset_id: { $ref: { step_id: "1", output: "audio_asset_id" } },
        },
      },
    ]);
    expect(steps).toMatchObject([
      { id: "extract" },
      {
        id: "replace",
        params: {
          audio_asset_id: { $ref: { step_id: "extract", output: "audio_asset_id" } },
        },
      },
    ]);
  });

  it("leaves a valid plan untouched, including duplicate ids", () => {
    const steps = extractReplaceSteps();
    expect(ensureChainStepIds(steps)).toBe(steps);
    const duplicate = [
      { id: "extract", tool: "extract_audio", params: { asset_id: "@b2" } },
      { id: "extract", tool: "trim_video", params: { asset_id: "@b2" } },
    ];
    expect(ensureChainStepIds(duplicate)).toBe(duplicate);
  });
});

describe("planStackedChainFromQuery", () => {
  it("routes the required extract-then-replace sentence including @ spelling", () => {
    const bare = planStackedChainFromQuery(
      "extract audio from b2 and use it to replace the audio on the video in c4",
    );
    const tagged = planStackedChainFromQuery(
      "extract audio from @b2 and use it to replace the audio on the video in @c4",
    );
    expect(bare?.steps).toEqual(extractReplaceSteps());
    expect(tagged?.steps).toEqual(extractReplaceSteps());
    expect(bare?.steps[1]?.params.audio_asset_id).toEqual({
      $ref: { step_id: "extract", output: "audio_asset_id" },
    });
  });

  it("routes another stacked local sequence without hard-coding the example", () => {
    const planned = planStackedChainFromQuery(
      "trim @a1 to 2 seconds then extract audio from it",
    );
    expect(planned?.steps.map((step) => step.tool)).toEqual([
      "trim_video",
      "extract_audio",
    ]);
    expect(planned?.steps[1]?.params.asset_id).toEqual({
      $ref: { step_id: "trim", output: "asset_id" },
    });
  });

  it("leaves ordinary single-tool requests alone", () => {
    expect(planStackedChainFromQuery("extract audio from @b2")).toBeNull();
    expect(planStackedChainFromQuery("replace the audio on @c4")).toBeNull();
    expect(planStackedChainFromQuery("trim @a1 to 2 seconds")).toBeNull();
  });
});

describe("preflightChainPlan", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (!root) return;
    const engine = createEngineForTest(root);
    closeEngineForTest(root, engine);
    await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function context(): Promise<ChainPreflightContext & { bookId: string }> {
    root = await mkdtemp(join(tmpdir(), "chain-preflight-"));
    const engine = createEngineForTest(root);
    await engine.ready;
    const schemas = new Map<string, ZodRawShape>(
      getAllToolDefs(engine).map((definition) => [definition.name, definition.schema]),
    );
    const bookId = engine.book.get().bookId;
    let notebook = engine.notebooks.list()[0];
    if (!notebook) {
      const created = await engine.notebooks.create("Main");
      if (!created.ok) throw new Error(created.error.message);
      notebook = created.value;
    }
    return {
      engine,
      bookId,
      notebookId: notebook.id,
      toolSchemas: schemas,
      autoApplyTools: AUTO_APPLY_TOOL_NAMES,
      effectForTool: (name) => effectForTool(name, "action"),
    };
  }

  async function seedVideos(ctx: ChainPreflightContext): Promise<void> {
    const notebookId = ctx.notebookId;
    if (!notebookId) throw new Error("missing notebook");
    const first = await ctx.engine.artifacts.create("video", "source-b2");
    const second = await ctx.engine.artifacts.create("video", "target-c4");
    if (!first.ok || !second.ok) throw new Error("failed to create artifacts");
    const cellB = ctx.engine.notebooks.createCell({
      type: "video",
      slot: { row: 1, column: 1 },
      outputArtifactId: first.value.artifactId,
    });
    const cellC = ctx.engine.notebooks.createCell({
      type: "video",
      slot: { row: 2, column: 3 },
      outputArtifactId: second.value.artifactId,
    });
    const insertedB = await ctx.engine.notebooks.insertCell(notebookId, cellB);
    const insertedC = await ctx.engine.notebooks.insertCell(notebookId, cellC);
    if (!insertedB.ok || !insertedC.ok) throw new Error("failed to place cells");
  }

  it("marks only the money-spending steps for their own review", async () => {
    const ctx = await context();
    await seedVideos(ctx);
    const result = await preflightChainPlan({
      action: "run",
      version: 1,
      book_id: ctx.bookId,
      notebook_id: ctx.notebookId,
      steps: [
        { id: "frame", tool: "extract_first_frame", params: { asset_id: "@b2" } },
        {
          id: "animate",
          tool: "generate_video",
          params: {
            model: "kie:bytedance/seedance-2-5",
            prompt: "Animate it",
            refs: { first_frame: { $ref: { step_id: "frame", output: "image_asset_id" } } },
          },
        },
      ],
    }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.map((step) => step.requiresApproval)).toEqual([false, true]);
    // Nothing needs the combined sheet: the frame auto-applies and the paid step
    // stops on its own.
    expect(result.plan.autoApply).toBe(true);
  });

  it("still shows one combined sheet when a free in-place mutation is in the chain", async () => {
    const ctx = await context();
    await seedVideos(ctx);
    const result = await preflightChainPlan({
      action: "run",
      version: 1,
      book_id: ctx.bookId,
      notebook_id: ctx.notebookId,
      steps: extractReplaceSteps(),
    }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.map((step) => step.requiresApproval)).toEqual([false, false]);
    expect(result.plan.autoApply).toBe(false);
  });

  it("pins every element of an array grid field", async () => {
    const ctx = await context();
    await seedVideos(ctx);
    const result = await preflightChainPlan({
      action: "run",
      version: 1,
      book_id: ctx.bookId,
      notebook_id: ctx.notebookId,
      steps: [
        {
          id: "animate",
          tool: "generate_video",
          params: {
            model: "kie:bytedance/seedance-2-5",
            prompt: "Blend them",
            refs: { video: ["@b2", "@c4"] },
          },
        },
      ],
    }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pins = result.plan.steps[0]?.pins ?? [];
    expect(pins.map((pin) => [pin.field, pin.index])).toEqual([
      ["refs.video", 0],
      ["refs.video", 1],
    ]);
    expect(pins.map((pin) => pin.address.replace(/^@/, ""))).toEqual(["b2", "c4"]);
  });

  it("accepts router steps that omitted ids", async () => {
    const ctx = await context();
    await seedVideos(ctx);
    const schema = ctx.toolSchemas.get("chain");
    if (!schema) throw new Error("missing chain schema");
    const steps = ensureChainStepIds([
      { tool: "extract_audio", params: { asset_id: "@b2" } },
      {
        tool: "replace_video_audio",
        params: {
          asset_id: "@c4",
          audio_asset_id: { $ref: { step_id: "1", output: "audio_asset_id" } },
        },
      },
    ]);
    const params = {
      action: "run",
      version: 1,
      book_id: ctx.bookId,
      notebook_id: ctx.notebookId,
      steps,
    };
    const validated = z.object(schema).safeParse(params);
    expect(validated.success).toBe(true);
    if (!validated.success) return;
    const result = await preflightChainPlan(params, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.map((step) => step.id)).toEqual([
      "extract_audio",
      "replace_video_audio",
    ]);
  });

  it("accepts a valid extract then replace $ref plan", async () => {
    const ctx = await context();
    await seedVideos(ctx);
    const result = await preflightChainPlan({
      action: "run",
      version: 1,
      book_id: ctx.bookId,
      notebook_id: ctx.notebookId,
      steps: extractReplaceSteps(),
    }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.map((step) => step.tool)).toEqual([
      "extract_audio",
      "replace_video_audio",
    ]);
    expect(result.plan.autoApply).toBe(false);
    expect(result.plan.effect).toBe("mutation");
    expect(result.plan.steps[0]?.pins[0]?.address.replace(/^@/, "")).toBe("b2");
    expect(result.plan.steps[1]?.pins[0]?.address.replace(/^@/, "")).toBe("c4");
  });

  it("accepts a third local media tool in the same contract", async () => {
    const ctx = await context();
    await seedVideos(ctx);
    const result = await preflightChainPlan({
      action: "run",
      version: 1,
      book_id: ctx.bookId,
      notebook_id: ctx.notebookId,
      steps: [
        {
          id: "trim",
          tool: "trim_video",
          params: { asset_id: "@b2", trim_start: 0, trim_end: 1 },
        },
        {
          id: "extract",
          tool: "extract_audio",
          params: {
            asset_id: { $ref: { step_id: "trim", output: "asset_id" } },
          },
        },
      ],
    }, ctx);
    expect(result.ok).toBe(true);
  });

  it("rejects empty, oversized, unknown, nested, and forward-ref plans", async () => {
    const ctx = await context();
    await seedVideos(ctx);
    const base = {
      action: "run" as const,
      version: 1 as const,
      book_id: ctx.bookId,
    };
    const empty = await preflightChainPlan({ ...base, steps: [] }, ctx);
    expect(empty.ok).toBe(false);

    const oversized = await preflightChainPlan({
      ...base,
      steps: Array.from({ length: 17 }, (_, index) => ({
        id: `step${index + 1}`,
        tool: "asset_manifest",
        params: { asset_id: UUID_A },
      })),
    }, ctx);
    expect(oversized.ok).toBe(false);

    const unknown = await preflightChainPlan({
      ...base,
      steps: [{ id: "x", tool: "not_a_tool", params: {} }],
    }, ctx);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toMatch(/unsupported|unknown/i);

    const nested = await preflightChainPlan({
      ...base,
      steps: [{ id: "x", tool: "chain", params: { action: "run" } }],
    }, ctx);
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.error).toMatch(/chain/);

    const chat = await preflightChainPlan({
      ...base,
      steps: [{ id: "x", tool: "chat", params: { prompt: "hi" } }],
    }, ctx);
    expect(chat.ok).toBe(false);

    const forward = await preflightChainPlan({
      ...base,
      notebook_id: ctx.notebookId,
      steps: [
        {
          id: "replace",
          tool: "replace_video_audio",
          params: {
            asset_id: "@c4",
            audio_asset_id: {
              $ref: { step_id: "extract", output: "audio_asset_id" },
            },
          },
        },
        {
          id: "extract",
          tool: "extract_audio",
          params: { asset_id: "@b2" },
        },
      ],
    }, ctx);
    expect(forward.ok).toBe(false);
    if (!forward.ok) expect(forward.error).toMatch(/forward/i);

    const self = await preflightChainPlan({
      ...base,
      steps: [{
        id: "extract",
        tool: "extract_audio",
        params: {
          asset_id: { $ref: { step_id: "extract", output: "audio_asset_id" } },
        },
      }],
    }, ctx);
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error).toMatch(/own output/i);

    const badType = await preflightChainPlan({
      ...base,
      notebook_id: ctx.notebookId,
      steps: [
        { id: "extract", tool: "extract_audio", params: { asset_id: "@b2" } },
        {
          id: "replace",
          tool: "replace_video_audio",
          params: {
            asset_id: "@c4",
            audio_asset_id: { $ref: { step_id: "extract", output: "job_id" } },
          },
        },
      ],
    }, ctx);
    expect(badType.ok).toBe(false);
    if (!badType.ok) expect(badType.error).toMatch(/incompatible/i);
  });

  it("rejects invalid grid targets and cross-book overrides before dispatch", async () => {
    const ctx = await context();
    const invalidGrid = await preflightChainPlan({
      action: "run",
      version: 1,
      book_id: ctx.bookId,
      notebook_id: ctx.notebookId,
      steps: [{
        id: "extract",
        tool: "extract_audio",
        params: { asset_id: "@zz9" },
      }],
    }, ctx);
    expect(invalidGrid.ok).toBe(false);
    if (!invalidGrid.ok) expect(invalidGrid.error).toMatch(/@a1-@bl8/i);

    const missing = await preflightChainPlan({
      action: "run",
      version: 1,
      book_id: ctx.bookId,
      notebook_id: ctx.notebookId,
      steps: [{
        id: "extract",
        tool: "extract_audio",
        params: { asset_id: "@b2" },
      }],
    }, ctx);
    expect(missing.ok).toBe(false);

    const otherBook = "019fcc00-0000-7000-8000-00000000ffff";
    const crossBook = await preflightChainPlan({
      action: "run",
      version: 1,
      book_id: ctx.bookId,
      steps: [{
        id: "extract",
        tool: "extract_audio",
        params: { asset_id: UUID_A, book_id: otherBook },
      }],
    }, ctx);
    expect(crossBook.ok).toBe(false);
    if (!crossBook.ok) expect(crossBook.error).toMatch(/cross-book/i);
  });

  it("rejects duplicate step ids and missing output fields", async () => {
    const ctx = await context();
    await seedVideos(ctx);
    const duplicate = await preflightChainPlan({
      action: "run",
      version: 1,
      book_id: ctx.bookId,
      notebook_id: ctx.notebookId,
      steps: [
        { id: "extract", tool: "extract_audio", params: { asset_id: "@b2" } },
        { id: "extract", tool: "trim_video", params: { asset_id: "@b2", trim_end: 1 } },
      ],
    }, ctx);
    expect(duplicate.ok).toBe(false);

    const missingOutput = await preflightChainPlan({
      action: "run",
      version: 1,
      book_id: ctx.bookId,
      notebook_id: ctx.notebookId,
      steps: [
        { id: "extract", tool: "extract_audio", params: { asset_id: "@b2" } },
        {
          id: "replace",
          tool: "replace_video_audio",
          params: {
            asset_id: "@c4",
            audio_asset_id: { $ref: { step_id: "extract", output: "nope" } },
          },
        },
      ],
    }, ctx);
    expect(missingOutput.ok).toBe(false);
    if (!missingOutput.ok) expect(missingOutput.error).toMatch(/unavailable output/i);
  });
});

describe("chain input schemas", () => {
  it("accepts status and cancel variants", () => {
    expect(chainStatusInputSchema.parse({
      action: "status",
      book_id: UUID_A,
      chain_id: UUID_B,
    }).action).toBe("status");
    expect(chainCancelInputSchema.parse({
      action: "cancel",
      book_id: UUID_A,
      chain_id: UUID_B,
    }).action).toBe("cancel");
  });

  it("accepts an approve variant naming the waiting step", () => {
    const parsed = chainApproveInputSchema.parse({
      action: "approve",
      book_id: UUID_A,
      chain_id: UUID_B,
      step_id: "animate",
      actor: "voice",
    });
    expect(parsed.step_id).toBe("animate");
    expect(parsed.actor).toBe("voice");
    expect(chainApproveInputSchema.safeParse({
      action: "approve",
      book_id: UUID_A,
      chain_id: UUID_B,
    }).success).toBe(false);
  });
});
