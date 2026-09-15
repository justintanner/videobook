import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { BookManager } from "../book-manager.js";
import { withBookContext } from "../book-context.js";
import type { Engine } from "videobook-engine";
import { chatActionPlanSchema, chatDef, prepareVoiceChatAction } from "./chat.js";
import type { ChatDecision } from "./chat.js";
import { listAssetsDef } from "./list-assets.js";
import type { ToolResult } from "./tool-def.js";
import { discoverVoiceActions, voiceWorkspaceContext } from "../voice-actions.js";

function value(result: ToolResult): unknown {
  if (result.isError) throw new Error(result.content[0]?.text);
  return JSON.parse(result.content[0]?.text ?? "null") as unknown;
}

describe("voice chat action policy", () => {
  let root: string;
  let books: BookManager;
  let engine: Engine;
  let bookId: string;
  let notebookId: string;
  let artifactId: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-voice-actions-"));
    books = new BookManager({ libraryDir: join(root, "books"), objectPrefix: "test-objects" });
    await books.ready();
    const created = await books.create("voice-actions");
    if (!created.ok) throw new Error(created.error.message);
    bookId = created.value.bookId;
    const managed = books.get(bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    engine = managed.value.engine;
    notebookId = engine.notebooks.list()[0]!.id;
    const artifact = await engine.artifacts.create("script", "original label");
    if (!artifact.ok) throw new Error(artifact.error.message);
    artifactId = artifact.value.artifactId;
  });

  afterAll(async () => {
    await books?.close();
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function prepare(prompt: string, decision: ChatDecision, targetNotebook = notebookId) {
    return withBookContext({ bookId, engine }, () => prepareVoiceChatAction(
      engine, { book_id: bookId, notebook_id: targetNotebook, prompt }, decision,
    ));
  }

  it("executes reads through the same registered tool without another model call", async () => {
    const actual = await prepare("List my assets", { tool: "list_assets", params: {}, message: "Here are your assets." });
    const expected = await listAssetsDef(engine).handler({ book_id: bookId });
    expect(value(actual)).toEqual(value(expected));
  });

  it("discovers bounded action schemas and current notebook context", () => {
    const actions = discoverVoiceActions(engine, "generate video");
    expect(actions.length).toBeLessThanOrEqual(8);
    expect(actions[0]?.name).toBe("generate_video");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.requiresReview).toBe(true);
    expect(actions[0]?.parameters.properties).not.toHaveProperty("book_id");
    expect(voiceWorkspaceContext(engine, notebookId)).toMatchObject({ book: "voice-actions", notebookId });
  });

  it("keeps specific model discovery available alongside exact action lookup", () => {
    expect(discoverVoiceActions(engine, "generate wan video").some(action => action.name.includes("wan"))).toBe(true);
    expect(discoverVoiceActions(engine, "rename asset").map(action => action.name)).toEqual(["rename_asset"]);
  });

  it("keeps the requested operation visible when media and cell words match many actions", () => {
    for (const query of ["rename image cell label", "rename cell", "rename image", "rename asset label", "relabel image cell"]) {
      const names = discoverVoiceActions(engine, query).map(action => action.name);
      expect(names, query).toContain("rename_asset");
      expect(names.findIndex(name => name === "rename_asset"), query).toBeLessThan(3);
    }
  });

  it("keeps a mutation pending until the normal chat plan is applied", async () => {
    const routed = await prepare(`Rename @${artifactId} to opening`, {
      tool: "rename_asset", params: { asset_id: artifactId, new_name: "opening" }, message: "Rename this asset to opening.",
    });
    const plan = chatActionPlanSchema.parse(value(routed));
    expect(plan.confirmation.required).toBe(true);
    expect(engine.artifacts.get(artifactId)).toMatchObject({ ok: true, value: { label: "original label" } });
    const applied = await withBookContext({ bookId, engine }, () => chatDef(engine).handler({ book_id: bookId, action_plan: plan }));
    expect(applied.isError).toBeUndefined();
    expect(engine.artifacts.get(artifactId)).toMatchObject({ ok: true, value: { label: "opening" } });
  });

  it("retains generation aliases, the options the speaker asked for, and the paid review gate", async () => {
    const result = await prepare("Generate a 5 second 720p cat video in 16:9", {
      tool: "generate_video",
      params: { prompt: "A cat playing", duration: "5", aspect_ratio: "16:9", resolution: "720p" },
      message: "Review this cat video generation.",
    });
    expect(chatActionPlanSchema.parse(value(result))).toMatchObject({
      tool: "generate_kie_seedance_2_5_video", effect: "generation",
      params: { duration: "5", aspect_ratio: "16:9", resolution: "720p" },
      confirmation: { required: true },
    });
  });

  it("drops generation options the speaker never asked for", async () => {
    const result = await prepare("Generate a cat video", {
      tool: "generate_video",
      params: { prompt: "A cat playing", duration: "5", aspect_ratio: "16:9", resolution: "720p" },
      message: "Review this cat video generation.",
    });
    const plan = chatActionPlanSchema.parse(value(result));
    expect(plan.params).not.toHaveProperty("duration");
    expect(plan.params).not.toHaveProperty("aspect_ratio");
    expect(plan.params).not.toHaveProperty("resolution");
    expect(plan.params).toMatchObject({ prompt: "A cat playing" });
  });

  it("retains the existing auto-apply policy for duplicate actions", async () => {
    const source = await engine.artifacts.create("image", "duplicate source");
    if (!source.ok) throw new Error(source.error.message);
    const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#39895a" } }).png().toBuffer();
    const stored = await engine.files.write(source.value.artifactId, "original.png", image);
    if (!stored.ok) throw new Error(stored.error.message);
    const routed = await prepare(`Duplicate @${source.value.artifactId} to @a1`, {
      tool: "duplicate_asset", params: { asset_id: source.value.artifactId, destination: "a1" }, message: "Duplicate this asset.",
    });
    const plan = chatActionPlanSchema.parse(value(routed));
    expect(plan.confirmation.required).toBe(false);
    const applied = await withBookContext({ bookId, engine }, () => chatDef(engine).handler({ book_id: bookId, action_plan: plan }));
    expect(applied.isError).toBeUndefined();
    expect(value(applied)).toMatchObject({ new_asset_id: expect.any(String), address: "@a1" });
  });

  it("rejects invalid parameters, unknown tools and missing notebook references", async () => {
    const invalid = await prepare("Rename this asset", { tool: "rename_asset", params: { asset_id: artifactId }, message: "Rename" });
    expect(invalid).toMatchObject({ isError: true });
    expect(invalid.content[0]?.text).toContain("Invalid parameters");
    const unknown = await prepare("Call something unknown", { tool: "unregistered_action", params: {}, message: "Unknown" });
    expect(unknown.content[0]?.text).toContain("Unknown tool");
    const missing = await prepare("Inspect @bl8", { tool: "list_assets", params: {}, message: "Inspect" });
    expect(missing.content[0]?.text).toContain("Asset not found");
    const wrongNotebook = await prepare("List assets", { tool: "list_assets", params: {}, message: "List" }, "01900000-0000-7000-8000-000000000099");
    expect(wrongNotebook.isError).toBe(true);
  });

  it("tags a spoken grid address so the drafted generation names the cell", async () => {
    const source = await engine.artifacts.create("image", "motion reference");
    if (!source.ok) throw new Error(source.error.message);
    const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#2f7d52" } }).png().toBuffer();
    const stored = await engine.files.write(source.value.artifactId, "reference.png", image);
    if (!stored.ok) throw new Error(stored.error.message);
    const document = engine.notebooks.read(notebookId);
    if (!document.ok) throw new Error(document.error.message);
    const written = await engine.notebooks.write({
      ...document.value,
      cells: [...document.value.cells, engine.notebooks.createCell({
        type: "image", slot: { row: 2, column: 0 }, outputArtifactId: source.value.artifactId,
      })],
    });
    if (!written.ok) throw new Error(written.error.message);

    const spoken = "Animate the image at C1 with a slow push in.";
    const routed = await prepare(spoken, { tool: "generate_video", params: { prompt: spoken }, message: spoken });
    const plan = chatActionPlanSchema.parse(value(routed));
    const tagged = "Animate the image at @c1 with a slow push in.";
    expect(plan.params.prompt).toBe(tagged);
    expect(plan.prompt).toBe(tagged);
    expect(plan.summary).toBe(tagged);
  });
});
