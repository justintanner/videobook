import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import { getAllToolDefs } from "./index.js";
import { providerStatusUrl } from "../provider-status-link.js";
import { readProviderTaskStatus } from "../provider-task-status.js";
import { preserveProviderTask } from "../provider-task-record.js";

describe("provider status details", () => {
  let rootDir: string;
  let engine: Engine;
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "provider-status-"));
    engine = createEngine({ rootDir, initialBookName: "status-links", durableWrites: false });
    await engine.ready;
  });
  afterEach(async () => {
    engine.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it.each(["kie", "fal"] as const)("keeps %s request IDs in job and generation details after failure and restart", async (provider) => {
    const asset = await engine.artifacts.create("image", "failed output");
    if (!asset.ok) throw new Error(asset.error.message);
    const artifactId = asset.value.artifactId;
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    const model = provider === "fal" ? "fal-ai/nano-banana-pro/edit" : "seedream/5-pro-image-to-image";
    const cell = engine.notebooks.createCell({ type: "generate_image", slot: { row: 0, column: 0 },
      provider, model, tool: "edit_image_subjects" });
    await engine.notebooks.write({ ...notebook.value, cells: [cell] });
    const job = engine.jobs.queue.enqueue({
      type: "generate_image_subject_edit", artifactId,
      payload: { type: "generate_image_subject_edit", imageAssetId: artifactId, modelId: model },
    }).job;
    expect(await engine.jobs.queue.abort(job.id, "Provider failed")).toBe(true);
    await engine.generations.record({
      notebookId: notebook.value.id, cellId: cell.id, status: "failed", tool: "edit_image_subjects",
      provider, model, providerArtifactId: artifactId,
    });
    await engine.metadata.artifacts.write(artifactId, "generation-payload", provider === "fal"
      ? { endpoint_id: model, input: { prompt: "edit" } } : { model, input: { prompt: "edit" } });
    if (provider === "fal") {
      await engine.metadata.artifacts.write(artifactId, "kie-task-id", { taskId: "fal-request-id" });
    } else {
      const owner = engine.jobs.artifactWork.begin(artifactId, { kind: "generate", ownerKind: "job", durationMs: 60_000 });
      if (!owner) throw new Error("Missing task owner");
      const written = await engine.jobs.pending.write({ artifactId, taskId: "kie-task-id", taskType: "seedance2_video",
        meta: { apiModel: model, apiKey: "must-not-leak" } }, owner.ownerId);
      if (!written.ok || !written.value) throw new Error("Task was not preserved");
      await preserveProviderTask(engine, written.value.task);
      const failed = await engine.jobs.pending.fail(artifactId, "kie-task-id", { message: "Provider failed" });
      expect(failed.ok && failed.value).toBeTruthy();
    }
    await engine.jobs.failures.write(artifactId, { message: "Provider failed" });
    engine.close();
    engine = createEngine({ rootDir, initialBookName: "status-links", durableWrites: false });
    await engine.ready;
    const definitions = getAllToolDefs(engine);
    const args = { book_id: engine.book.get().bookId, notebook_id: notebook.value.id, cell_id: cell.id, asset_id: artifactId };
    for (const name of ["list_jobs", "list_cell_generations", "inspect_generation_request"]) {
      const response = await definitions.find((definition) => definition.name === name)!.handler(args);
      expect(response.isError).not.toBe(true);
      const text = response.content[0]!.text!;
      expect(text).not.toContain("must-not-leak");
      const parsed = JSON.parse(text) as { providerTask?: unknown; attempts?: Array<{ providerTask: unknown }> } | Array<{ providerTask: unknown }>;
      const task = Array.isArray(parsed) ? parsed[0]!.providerTask : parsed.providerTask ?? parsed.attempts![0]!.providerTask;
      expect(task).toEqual({ provider, model, taskId: provider === "fal" ? "fal-request-id" : "kie-task-id" });
    }
    expect(providerStatusUrl(provider, model)).toBe(provider === "fal"
      ? "https://fal.ai/models/fal-ai/nano-banana-pro/edit/requests" : "https://kie.ai/logs");
  });

  it("does not identify another provider or an unsafe model as a fal or Kie page", async () => {
    expect(await readProviderTaskStatus(engine, null, { provider: "xai", taskId: "xai-task" })).toBeNull();
    expect(providerStatusUrl("fal", "https://example.test/api-key")).toBeNull();
    expect(providerStatusUrl("fal", "fal-ai/../settings")).toBeNull();
    expect(providerStatusUrl("fal", "fal-ai/model?key=secret")).toBeNull();
  });
});
