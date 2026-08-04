import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import {
  failNotebookProviderOutput,
  type AwaitNotebookOutputPayload,
} from "../../server/src/jobs/run-notebook.js";
import {
  hydrateNotebookProviderFailures,
  notebookProviderFailureMessage,
} from "../../server/src/notebook-provider-failure.js";

describe("notebook provider failures", () => {
  let rootDir: string;
  let engine: Engine;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-provider-failure-"));
    engine = createEngine({ rootDir, initialBookName: "provider-failure" });
    await engine.ready;
  });

  afterEach(async () => {
    engine.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  async function setupFailure(
    provider: string,
    tool: string,
  ): Promise<{ input: AwaitNotebookOutputPayload; cellId: string }> {
    const artifact = await engine.artifacts.create({
      kind: "video",
      label: "provider output",
    });
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) throw new Error(artifact.error.message);
    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const cell = engine.notebooks.createCell({
      type: "generate_video",
      label: "Generate video",
      slot: { row: 0, column: 0 },
      provider,
      model: tool,
      operation: "image_to_video",
      tool,
    });
    const runId = "019f0000-0000-7000-8000-000000000011";
    const written = await engine.notebooks.write({
      ...notebook.value,
      cells: [cell],
      execution: {
        [cell.id]: {
          fingerprint: "provider-failure",
          status: "awaiting-output",
          providerArtifactId: artifact.value.artifactId,
          runId,
        },
      },
    });
    expect(written.ok).toBe(true);
    return {
      cellId: cell.id,
      input: {
        type: "await_notebook_output",
        bookId: engine.book.get().bookId,
        notebookId: notebook.value.id,
        cellId: cell.id,
        providerArtifactId: artifact.value.artifactId,
        runId,
      },
    };
  }

  it("persists a real Google Flow failure and actionable guidance on the cell", async () => {
    const { input, cellId } = await setupFailure(
      "google_flow",
      "generate_google_flow_omni_flash_video",
    );
    const failure = await engine.jobs.failures.write(input.providerArtifactId, {
      message: "All operations failed: PUBLIC_ERROR_REPUTATIONAL (REPUTATIONAL)",
      failCode: "PUBLIC_ERROR_REPUTATIONAL",
    });
    expect(failure.ok).toBe(true);

    await failNotebookProviderOutput(engine, input);

    const notebook = engine.notebooks.read(input.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[cellId]).toMatchObject({
      status: "error",
      providerArtifactId: input.providerArtifactId,
      error: expect.stringContaining(
        "Google Flow failed: All operations failed: PUBLIC_ERROR_REPUTATIONAL (REPUTATIONAL)",
      ),
    });
    expect(String(notebook.value.execution?.[cellId]?.error))
      .toContain("Use fictional or stylized subjects");
  });

  it("shows generic provider details while redacting secrets", async () => {
    const { input } = await setupFailure(
      "kie",
      "generate_kie_kling_3_0_motion_control",
    );
    const secret = "provider-secret-value";
    const previousApiKey = process.env.KIE_API_KEY;
    process.env.KIE_API_KEY = secret;
    try {
      const failure = await engine.jobs.failures.write(input.providerArtifactId, {
        message: `Quota exhausted; apiKey=${secret}; Authorization: Bearer bearer-secret-value`,
        failCode: "429",
      });
      expect(failure.ok).toBe(true);
      const message = notebookProviderFailureMessage(engine, input);
      expect(message).toContain("Kie failed: Quota exhausted");
      expect(message).toContain("(429)");
      expect(message).not.toContain(secret);
      expect(message).not.toContain("bearer-secret-value");
      expect(message).toContain("apiKey=[redacted]");
      expect(message).toContain("Authorization: [redacted]");
    } finally {
      if (previousApiKey === undefined) delete process.env.KIE_API_KEY;
      else process.env.KIE_API_KEY = previousApiKey;
    }
  });

  it("retains the artifact fallback when no failure record exists", async () => {
    const { input } = await setupFailure(
      "kie",
      "generate_kie_kling_3_0_motion_control",
    );
    expect(notebookProviderFailureMessage(engine, input)).toBe(
      `Provider output ${input.providerArtifactId} failed`,
    );
  });

  it("hydrates an already-persisted opaque error for notebook reads", async () => {
    const { input, cellId } = await setupFailure(
      "kie",
      "generate_kie_kling_3_0_motion_control",
    );
    const failure = await engine.jobs.failures.write(input.providerArtifactId, {
      message: "Motion video duration must be between 3 and 30 seconds",
      failCode: "INVALID_INPUT",
    });
    expect(failure.ok).toBe(true);
    const notebook = engine.notebooks.read(input.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    const opaque = {
      ...notebook.value,
      execution: {
        ...notebook.value.execution,
        [cellId]: {
          ...notebook.value.execution?.[cellId],
          status: "error",
          error: `Provider output ${input.providerArtifactId} failed`,
        },
      },
    };

    const hydrated = hydrateNotebookProviderFailures(engine, opaque);

    expect(hydrated.execution?.[cellId]?.error).toBe(
      "Kie failed: Motion video duration must be between 3 and 30 seconds (INVALID_INPUT)",
    );
  });
});
