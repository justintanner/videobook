import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import { assertProviderPayload } from "../provider-prompt-transform.js";
import { notebookCellDefinitionFingerprint } from "./run-notebook.js";
import {
  claimNotebookRunPlan,
  planSelectedNotebookSubgraph,
} from "../notebook-run-plan.js";
import {
  assessBestEffortEstimate,
  assessKieRequestEstimate,
  assessToolCallEstimate,
  sanitizedCostEstimateLog,
  type CostEstimateLogContext,
} from "./cost-estimate-assessment.js";
import { authorizeKiePaygate, mintKieOtp } from "./kie-paygate.js";
import { canonicalHash, parseOtp } from "@apicity/cost";
import { MediaGenerationRequestSchema } from "@apicity/kie/zod";

describe("advisory cost estimation", () => {
  it("estimates both Klein requests through the shared KIE cost path", () => {
    for (const model of ["flux-3/klein-text-to-image", "flux-3/klein-edit-image"] as const) {
      const assessment = assessKieRequestEstimate(MediaGenerationRequestSchema.parse({
        model,
        input: { prompt: "a fox", image_urls: ["https://example.test/source.png"], resolution: "2K", num_images: 3 },
      }));
      expect(assessment.available).toBe(true);
      expect(assessment.usd).toBeCloseTo(0.0375);
      expect(assessment.warnings).toEqual([]);
    }
  });

  it("carries input-video duration into the provider request estimate", () => {
    const assessment = assessKieRequestEstimate({
      model: "bytedance/seedance-2-5",
      input: {
        prompt: "Continue the scene", duration: 5, resolution: "1080p",
        reference_video_urls: ["https://example.test/source.mp4"],
      },
    }, { inputDuration: 10 });
    expect(assessment.available).toBe(true);
    expect(assessment.usd).toBeCloseTo(15 * 0.3425);
    expect(assessment.warnings).toEqual([]);
  });

  let rootDir: string;
  let engine: Engine;
  let previousSecret: string | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-estimate-advisory-"));
    engine = createEngine({ durableWrites: false, rootDir, initialBookName: "estimate-advisory" });
    await engine.ready;
    previousSecret = process.env.APICITY_PAYGATE_SECRET;
    process.env.APICITY_PAYGATE_SECRET = "test-secret";
  });

  afterEach(async () => {
    engine.close();
    if (previousSecret === undefined) delete process.env.APICITY_PAYGATE_SECRET;
    else process.env.APICITY_PAYGATE_SECRET = previousSecret;
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  const klingTransformation = {
    model: "kling-3.0-omni/transformation" as const,
    input: {
      prompt: "restyle the source clip as watercolor",
      image_urls: ["https://kie.example/style.png"],
      video_urls: ["https://kie.example/source.mp4"],
      aspect_ratio: "9:16" as const,
    },
  };

  it("treats thrown estimators as unavailable without failing", () => {
    const assessment = assessBestEffortEstimate(() => {
      throw new Error("KIE cost estimate is not bounded: secret otp_leak");
    });
    expect(assessment).toEqual({
      available: false,
      warnings: [],
      reason: "estimator-threw",
    });
  });

  it("treats missing adapters as unavailable", async () => {
    const assessment = await assessToolCallEstimate(
      engine,
      "not_a_registered_generation_tool",
      { prompt: "should not appear in logs" },
    );
    expect(assessment.available).toBe(false);
    if (assessment.available) throw new Error("Expected an unavailable estimate");
    expect(assessment.reason).toBe("missing-adapter");
  });

  it("keeps Kling 3.0 Omni transformation request-hash OTP binding when unbounded", async () => {
    const assessment = assessKieRequestEstimate(klingTransformation);
    expect(assessment.available).toBe(false);
    const authorized = await authorizeKiePaygate(klingTransformation, {
      engine,
      correlation: {
        bookId: engine.book.get().bookId,
        artifactId: "01900000-0000-7000-8000-000000000010",
        tool: "kling30_omni_video",
        stage: "submit-kie",
      },
    });
    expect(authorized.assessment.available).toBe(false);
    expect(parseOtp(authorized.otp).payload.requestHash).toBe(
      canonicalHash(klingTransformation),
    );
    expect(mintKieOtp(klingTransformation, 60)).toEqual(expect.any(String));
    const log = JSON.stringify(engine.logs.read("generation-cost-estimate"));
    expect(log).toContain("01900000-0000-7000-8000-000000000010");
    expect(log).not.toContain("watercolor");
    expect(log).not.toContain("https://kie.example/source.mp4");
    expect(log).not.toContain(authorized.otp);
  });

  it("omits secrets, OTPs, prompts, and media URLs from sanitized diagnostics", () => {
    const line = sanitizedCostEstimateLog({
      assessment: {
        available: false,
        warnings: ["model 'kling-3.0-omni/transformation' not found"],
        reason: "unbounded",
      },
      correlation: {
        bookId: "01900000-0000-7000-8000-000000000011",
        artifactId: "01900000-0000-7000-8000-000000000012",
        runId: "run-1",
        jobId: "job-1",
        tool: "kling30_omni_video",
        provider: "kie",
        model: "kling-3.0-omni/transformation",
        stage: "submit-kie",
        prompt: "secret prompt",
      } as CostEstimateLogContext & { prompt: string },
    });
    const serialized = JSON.stringify(line);
    expect(line).toMatchObject({
      event: "generation-cost-estimate",
      available: false,
      reason: "unbounded",
      bookId: "01900000-0000-7000-8000-000000000011",
      artifactId: "01900000-0000-7000-8000-000000000012",
      stage: "submit-kie",
    });
    expect(serialized).not.toContain("secret prompt");
    expect(serialized).not.toContain("otp_");
    expect(serialized).not.toContain("https://");
    expect(line).not.toHaveProperty("prompt");
    expect(line).not.toHaveProperty("payload");
    expect(line).not.toHaveProperty("model");
    expect(line).not.toHaveProperty("runId");
    expect(line).not.toHaveProperty("jobId");
  });

  it("still rejects unresolved provider mentions as invalid payloads", () => {
    expect(() => assertProviderPayload({
      model: "kling-3.0-omni/transformation",
      input: {
        prompt: "restyle @01900000-0000-7000-8000-000000000099",
        video_urls: ["https://kie.example/source.mp4"],
      },
    }, { toolName: "kling30_omni_video", wire: true })).toThrow(/Unresolved provider mention/);
  });

  it("plans and claims a generation subgraph without confirm_unpriced", async () => {
    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const video = await engine.artifacts.create({
      kind: "video",
      label: "source video",
    });
    const image = await engine.artifacts.create({
      kind: "image",
      label: "style image",
    });
    expect(video.ok && image.ok).toBe(true);
    if (!video.ok || !image.ok) throw new Error("artifacts");
    const sourceVideo = engine.notebooks.createCell({
      type: "video",
      slot: { row: 0, column: 0 },
      outputArtifactId: video.value.artifactId,
    });
    const sourceImage = engine.notebooks.createCell({
      type: "image",
      slot: { row: 0, column: 1 },
      outputArtifactId: image.value.artifactId,
    });
    const producer = engine.notebooks.createCell({
      type: "generate_video",
      label: "Kling transform",
      slot: { row: 1, column: 0 },
      prompt: "restyle the source clip as watercolor",
      provider: "kie",
      model: "kie:kling-3.0-omni/transformation",
      operation: "edit_video",
      tool: "generate_video",
    });
    const written = await engine.notebooks.write({
      ...notebook.value,
      cells: [sourceVideo, sourceImage, producer],
      edges: [
        engine.notebooks.createEdge({
          source: sourceImage.id,
          target: producer.id,
          targetInput: "image_refs",
        }),
        engine.notebooks.createEdge({
          source: sourceVideo.id,
          target: producer.id,
          targetInput: "video_refs",
        }),
      ],
    });
    expect(written.ok).toBe(true);
    const document = engine.notebooks.read(notebook.value.id);
    expect(document.ok).toBe(true);
    if (!document.ok) throw new Error(document.error.message);

    const plan = await planSelectedNotebookSubgraph(
      engine,
      document.value,
      producer.id,
      "ui",
      "tester",
    );
    expect(plan.planId).toEqual(expect.any(String));
    const stages = plan.stages as Array<Record<string, unknown>>;
    const paid = stages.find((stage) => stage.cellId === producer.id);
    expect(paid?.kind).toBe("queued");
    expect(paid?.jobType).toBe("generation");
    expect(paid?.tool).toBe("generate_video");
    expect(paid?.model).toBe("kie:kling-3.0-omni/transformation");

    const fingerprint = notebookCellDefinitionFingerprint(document.value, producer);
    const unpricedPlanId = "019f0000-0000-7000-8000-00000000c0de";
    const now = new Date().toISOString();
    const current = engine.notebooks.read(notebook.value.id);
    if (!current.ok) throw new Error(current.error.message);
    const withUnpriced = await engine.notebooks.write({
      ...current.value,
      notebookRunPlans: [{
        planId: unpricedPlanId,
        status: "planned",
        plan: {
          ...plan,
          planId: unpricedPlanId,
          notebookRun: {
            notebookId: notebook.value.id,
            targetCellId: producer.id,
            mode: "subgraph",
            noOp: false,
          },
        },
        paidCellIds: [producer.id],
        cellDefinitionFingerprints: { [producer.id]: fingerprint },
        knownCostUsd: 0,
        unknownCostCount: 3,
        createdAt: now,
        updatedAt: now,
      }],
    });
    expect(withUnpriced.ok).toBe(true);
    const claimed = await claimNotebookRunPlan(
      engine,
      notebook.value.id,
      unpricedPlanId,
      "run-unpriced",
      { confirmUnpriced: false },
    );
    expect(claimed.record.status).toBe("queued");
    expect(claimed.record.runId).toBe("run-unpriced");
    expect(claimed.record.unknownCostCount).toBe(3);
  });
});
