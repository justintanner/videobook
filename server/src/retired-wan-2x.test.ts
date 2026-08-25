import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scopedEngine, closeEngineForTest, createEngineForTest } from "./engine.js";
import {
  GENERATION_ACTIONS,
  RETIRED_GENERATION_ACTIONS,
  RETIRED_WAN_2X_TOOL_NAMES,
  getActionSpec,
  getCanonicalName,
  isGenerationAction,
} from "./generation-registry.js";
import { VIDEO_MODELS, buildVideoRoutingPrompt } from "./video-models.js";
import { getImageModels } from "./image-models.js";
import { getAllToolDefs } from "./tools/index.js";
import { listNotebookActions } from "./notebook-action-catalog.js";
import { renderCommandReference, renderGenerationNamingManifest } from "./command-reference.js";
import { getCanonicalCommands } from "./tools/commands.js";
import { listCellGenerationsDef } from "./tools/list-cell-generations.js";
import type { ListCellGenerationsResponse } from "./tools/list-cell-generations.js";
import { queue as appQueue, setEngineRoot } from "./queue.js";

const RETIRED_WAN_2X_CANONICAL_NAMES = [
  "generate_kie_wan_2_7_text_to_video",
  "generate_kie_wan_2_7_image_to_video",
  "generate_kie_wan_2_7_edit_video",
  "generate_kie_wan_2_7_reference_to_video",
  "extend_kie_wan_2_7_video",
  "generate_kie_wan_2_7_text_to_image",
  "generate_kie_wan_2_7_pro_text_to_image",
  "generate_alibaba_wan_2_7_text_to_image",
  "generate_alibaba_wan_2_7_pro_text_to_image",
  "generate_alibaba_wan_2_7_video",
  "generate_fal_wan_2_7_text_to_image",
  "generate_fal_wan_2_7_edit_image",
  "generate_fal_wan_2_7_pro_text_to_image",
  "generate_fal_wan_2_7_pro_edit_image",
  "generate_fal_wan_2_7_text_to_video",
  "generate_fal_wan_2_7_image_to_video",
  "generate_fal_wan_2_7_reference_to_video",
  "generate_fal_wan_2_7_edit_video",
];

describe("retired Wan 2.x surfaces", () => {
  it("keeps retired names only as history aliases, not as registered tools", () => {
    const registered = new Set(getAllToolDefs(scopedEngine).map((tool) => tool.name));
    const live = new Set(GENERATION_ACTIONS.map((action) => action.canonical_name));
    expect(RETIRED_WAN_2X_TOOL_NAMES.length).toBeGreaterThan(0);
    for (const name of RETIRED_WAN_2X_TOOL_NAMES) {
      expect(registered.has(name), name).toBe(false);
      expect(live.has(name), name).toBe(false);
      expect(isGenerationAction(name), name).toBe(true);
      expect(RETIRED_WAN_2X_CANONICAL_NAMES.includes(getCanonicalName(name)), name).toBe(true);
    }
    expect(RETIRED_GENERATION_ACTIONS.map((action) => action.canonical_name)).toEqual(
      expect.arrayContaining(RETIRED_WAN_2X_CANONICAL_NAMES),
    );
    expect(
      RETIRED_GENERATION_ACTIONS.filter((action) => RETIRED_WAN_2X_CANONICAL_NAMES.includes(action.canonical_name)),
    ).toHaveLength(18);
  });

  it("keeps persisted wan27 history readable through the retired specs", () => {
    const video = getActionSpec("generate_wan27_i2v_video");
    expect(video?.canonical_name).toBe("generate_kie_wan_2_7_image_to_video");
    expect(video?.job_task_discriminator).toBe("wan27_video_gen");
    expect(video?.persisted_history_consumers).toEqual(
      expect.arrayContaining(["notebook", "prompt_history", "project_activity"]),
    );
    const alibaba = getActionSpec("generate_alibaba_image");
    expect(alibaba?.canonical_name).toBe("generate_alibaba_wan_2_7_text_to_image");
    expect(alibaba?.persisted_history_consumers).toEqual(
      expect.arrayContaining(["notebook", "prompt_history", "project_activity"]),
    );
    const fal = getActionSpec("generate_wan27_videoedit_fal");
    expect(fal?.canonical_name).toBe("generate_fal_wan_2_7_edit_video");
  });

  it("hides retired names from pickers, routing, catalogs, and docs", () => {
    const pickerTools = [
      ...Object.values(VIDEO_MODELS).map((model) => model.tool_name),
      ...Object.values(getImageModels()).map((model) => model.tool_name),
    ];
    const routing = buildVideoRoutingPrompt();
    const catalogTools = listNotebookActions().map((action) => action.tool);
    const docs = renderCommandReference(
      getAllToolDefs(scopedEngine),
      getCanonicalCommands(),
      GENERATION_ACTIONS,
    );
    const manifest = renderGenerationNamingManifest(GENERATION_ACTIONS);
    for (const name of RETIRED_WAN_2X_TOOL_NAMES) {
      expect(pickerTools.includes(name), name).toBe(false);
      expect(routing.includes(name), name).toBe(false);
      expect(catalogTools.includes(name), name).toBe(false);
      expect(docs.includes(name), name).toBe(false);
      expect(manifest.includes(name), name).toBe(false);
    }
  });
});

describe("legacy Wan 2.x book data", () => {
  let root: string;
  let engine: ReturnType<typeof createEngineForTest> | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "retired-wan-2x-"));
  });

  afterEach(async () => {
    await appQueue.stop();
    if (engine) {
      closeEngineForTest(root, engine);
      engine = undefined;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("renders asset and prompt history for a persisted wan27 generation", async () => {
    engine = createEngineForTest(root);
    const notebookResult = await engine.notebooks.create("Legacy");
    if (!notebookResult.ok) throw new Error(notebookResult.error.message);
    const notebook = notebookResult.value;
    const cell = engine.notebooks.createCell({
      type: "generate_video",
      slot: { row: 0, column: 0 },
      prompt: "a cat dances",
      tool: "generate_kie_wan_2_7_image_to_video",
      model: "wan/2-7-image-to-video",
    });
    const inserted = await engine.notebooks.insertCell(notebook.id, cell);
    if (!inserted.ok) throw new Error(inserted.error.message);
    const output = await engine.artifacts.create("video", "legacy-wan27-out");
    if (!output.ok) throw new Error(output.error.message);

    const recorded = await engine.generations.record({
      notebookId: notebook.id,
      cellId: cell.id,
      tool: "generate_kie_wan_2_7_image_to_video",
      provider: "kie",
      model: "wan/2-7-image-to-video",
      prompt: "a cat dances",
      runId: "run-legacy-1",
    });
    if (!recorded.ok) throw new Error(recorded.error.message);
    const updated = await engine.generations.update(recorded.value.generationId, {
      status: "completed",
      outputArtifactId: output.value.artifactId,
    });
    if (!updated.ok) throw new Error(updated.error.message);

    const result = await listCellGenerationsDef(engine).handler({
      book_id: engine.book.get().bookId,
      notebook_id: notebook.id,
      cell_id: cell.id,
      limit: 10,
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as ListCellGenerationsResponse;
    expect(data.attempts).toHaveLength(1);
    const attempt = data.attempts[0];
    expect(attempt?.tool).toBe("generate_kie_wan_2_7_image_to_video");
    expect(attempt?.provider).toBe("kie");
    expect(attempt?.model).toBe("wan/2-7-image-to-video");
    expect(attempt?.prompt).toBe("a cat dances");
    expect(attempt?.status).toBe("completed");
    expect(attempt?.artifactId).toBe(output.value.artifactId);
    expect(data.generations.artifactIds).toContain(output.value.artifactId);
  });

  it("fails retry of a retired wan27 job with a clear no-handler error", async () => {
    engine = createEngineForTest(root);
    await setEngineRoot(root, engine);
    const bookId = engine.book.get().bookId;

    const legacy = await appQueue.enqueue("legacy-wan27-job", {
      type: "wan27_video_gen",
      bookId,
    });
    const legacyDeadline = Date.now() + 10_000;
    let legacyError: string | null = null;
    while (Date.now() < legacyDeadline) {
      const status = await appQueue.getStatus("legacy-wan27-job");
      if (status?.state === "failed") {
        legacyError = status.error?.message ?? null;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(legacyError).toContain("No handler for job type: wan27_video_gen");

    const retryTool = getAllToolDefs(engine).find((tool) => tool.name === "retry_job");
    if (!retryTool) throw new Error("retry_job tool not registered");
    const result = await retryTool.handler({ book_id: bookId, job_id: legacy.id });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as {
      status: string;
      retry_job_id: string;
      source_job_id: number;
    };
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_job_id).toBe(legacy.id);

    const retryDeadline = Date.now() + 10_000;
    let retryError: string | null = null;
    while (Date.now() < retryDeadline) {
      const status = await appQueue.getStatus(parsed.retry_job_id);
      if (status?.state === "failed") {
        retryError = status.error?.message ?? null;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(retryError).toContain("No handler for job type: wan27_video_gen");
  });
});
