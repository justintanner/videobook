import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createEngine } from "videobook-engine";

import { withLogging } from "./log-wrapper.js";
import { videobookDomainDefs } from "./videobook-domain.js";
import type { ToolDef } from "./tool-def.js";

function resultValue(result: Awaited<ReturnType<ToolDef["handler"]>>): unknown {
  const text = result.content[0]?.text;
  return text ? JSON.parse(text) as unknown : null;
}

describe("project book tools", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("records explicit lifecycle and layout actions in the canonical book", async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-project-book-"));
    const fs = createEngine({ rootDir: root });
    await fs.projects.create("studio");
    const prompt = await fs.artifacts.create({
      project: "studio",
      kind: "prompt",
      slug: "prm-cat",
    });
    if (!prompt.ok) throw new Error(prompt.error.message);
    const tools = new Map(
      videobookDomainDefs(fs).map((definition) => [
        definition.name,
        definition,
      ]),
    );
    const record = tools.get("record_book_action");
    const layout = tools.get("record_book_layout");
    const read = tools.get("get_project_book");
    if (!record || !layout || !read) throw new Error("Missing book tools");

    const created = await record.handler({
      project_slug: "studio",
      action_id: "prompt-action",
      operation: "create_prompt",
      scope: "artifact",
      output_artifact_ids: ["prm-cat"],
      stage: 0,
      column: 0,
      details: { prompt: "A white cat" },
    });
    expect(created.isError).toBeUndefined();
    const moved = await layout.handler({
      project_slug: "studio",
      target_action_id: "prompt-action",
      stage: 2,
      column: 1,
    });
    expect(moved.isError).toBeUndefined();

    const bookResult = await read.handler({
      project_slug: "studio",
      limit: 100,
    });
    const book = resultValue(bookResult) as {
      actions: Array<{
        id: string;
        scope: string;
        targetActionId?: string;
        layout?: { stage: number; column: number };
      }>;
    };
    expect(book.actions.find((action) => action.id === "prompt-action"))
      .toMatchObject({
        scope: "artifact",
        layout: { stage: 0, column: 0 },
      });
    expect(book.actions.find((action) =>
      action.targetActionId === "prompt-action"
    )).toMatchObject({
      scope: "layout",
      layout: { stage: 2, column: 1 },
    });
    fs.close();
  });

  it("records a successful inherited write tool with inputs and outputs", async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-wrapper-book-"));
    const fs = createEngine({ rootDir: root });
    await fs.projects.create("studio");
    const prompt = await fs.artifacts.create({
      project: "studio",
      kind: "prompt",
      slug: "prm-cat",
    });
    const image = await fs.artifacts.create({
      project: "studio",
      kind: "image",
      slug: "img-cat",
    });
    if (!prompt.ok) throw new Error(prompt.error.message);
    if (!image.ok) throw new Error(image.error.message);
    const wrapped = withLogging({
      name: "generate_test_image",
      description: "test",
      schema: {
        project_slug: z.string(),
        prompt_slug: z.string(),
      },
      handler: async () => ({
        content: [{
          type: "text",
          text: JSON.stringify({
            asset_id: "img-cat",
            source_prompt: "prm-cat",
          }),
        }],
      }),
    }, fs);
    await wrapped.handler({
      project_slug: "studio",
      prompt_slug: "@prm-cat",
    });

    const book = await fs.history.projectBook("studio", { limit: 100 });
    expect(book.ok).toBe(true);
    if (!book.ok) throw new Error(book.error.message);
    expect(book.value.actions.find((action) =>
      action.operation === "tool-generate-test-image"
    )).toMatchObject({
      scope: "artifact",
      inputArtifacts: [{
        id: prompt.value.artifactId,
        slug: "prm-cat",
      }],
      outputArtifacts: [{
        id: image.value.artifactId,
        slug: "img-cat",
      }],
      targetArtifactId: image.value.artifactId,
      phase: "completed",
      events: [
        { phase: "requested" },
        { phase: "completed" },
      ],
    });
    fs.close();
  });

  it("records failed inherited writes as lifecycle trails", async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-wrapper-failed-book-"));
    const fs = createEngine({ rootDir: root });
    await fs.projects.create("studio");
    const image = await fs.artifacts.create({
      project: "studio",
      kind: "image",
      slug: "img-cat",
    });
    if (!image.ok) throw new Error(image.error.message);
    const wrapped = withLogging({
      name: "generate_test_video",
      description: "test",
      schema: {
        project_slug: z.string(),
        image_slug: z.string(),
      },
      handler: async () => ({
        isError: true,
        content: [{ type: "text", text: "provider failed" }],
      }),
    }, fs);
    await wrapped.handler({
      project_slug: "studio",
      image_slug: "@img-cat",
    });

    const book = await fs.history.projectBook("studio", { limit: 100 });
    expect(book.ok).toBe(true);
    if (!book.ok) throw new Error(book.error.message);
    expect(book.value.actions.find((action) =>
      action.operation === "tool-generate-test-video"
    )).toMatchObject({
      phase: "failed",
      inputArtifacts: [{
        id: image.value.artifactId,
        slug: "img-cat",
      }],
      outputArtifacts: [],
      events: [
        { phase: "requested" },
        { phase: "failed" },
      ],
    });
    fs.close();
  });
});
