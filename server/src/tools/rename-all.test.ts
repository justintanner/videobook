import { createEngineForTest } from "../fs.js";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  slugifyName,
  humanizeSlug,
  prefixOf,
  isRenamable,
  computeTargetSlug,
  buildRenameRows,
  validateEditedRenames,
  applyableRows,
  buildSuggestionPrompt,
  parseSuggestionResponse,
  rewriteTimelineReferences,
  rewriteDeep,
  isProcessOrigin,
  leadingMnemonicTokens,
  withPreservedMnemonic,
} from "../rename-helpers.js";

type TextContent = Array<{ type: string; text: string }>;

// ---------------------------------------------------------------------------
// Pure helper unit tests
// ---------------------------------------------------------------------------

describe("slugifyName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyName("Sunset Beach", "vid")).toBe("vid-sunset-beach");
  });

  it("strips non-alphanumeric characters", () => {
    expect(slugifyName("Cat's Toy! 100%", "img")).toBe("img-cats-toy-100");
  });

  it("filters stop words", () => {
    expect(slugifyName("The Dog on a Beach", "vid")).toBe("vid-dog-beach");
  });

  it("truncates to 4 content words", () => {
    expect(slugifyName("one two three four five six", "vid")).toBe("vid-one-two-three-four");
  });

  it("deduplicates consecutive identical words", () => {
    expect(slugifyName("neon neon fox", "img")).toBe("img-neon-fox");
  });

  it("falls back to untitled when all words filtered", () => {
    expect(slugifyName("the a an of", "vid")).toBe("vid-untitled");
    expect(slugifyName("", "img")).toBe("img-untitled");
  });

  it("filters the prefix word itself", () => {
    expect(slugifyName("vid neon fox", "vid")).toBe("vid-neon-fox");
  });
});

describe("humanizeSlug", () => {
  it("strips prefix and title-cases", () => {
    expect(humanizeSlug("vid-sunset-beach")).toBe("Sunset Beach");
    expect(humanizeSlug("img-neon-fox")).toBe("Neon Fox");
  });

  it("handles single-word slugs", () => {
    expect(humanizeSlug("vid-fox")).toBe("Fox");
  });
});

describe("prefixOf / isRenamable", () => {
  it("extracts prefix", () => {
    expect(prefixOf("vid-abc")).toBe("vid");
    expect(prefixOf("img-xyz")).toBe("img");
  });

  it("only vid/img are renamable", () => {
    expect(isRenamable("vid-abc")).toBe(true);
    expect(isRenamable("img-abc")).toBe(true);
    expect(isRenamable("char-bob")).toBe(false);
    expect(isRenamable("aud-clip")).toBe(false);
  });
});

describe("computeTargetSlug", () => {
  it("returns base slug when no batch-internal collision", () => {
    const target = computeTargetSlug("sunset beach", "vid-old1", new Set());
    expect(target).toBe("vid-sunset-beach");
  });

  it("suffixes on collision with a claimed batch target", () => {
    const claimed = new Set(["vid-sunset-beach"]);
    const target = computeTargetSlug("sunset beach", "vid-old1", claimed);
    expect(target).toBe("vid-sunset-beach-2");
  });

  it("returns base unchanged when it equals the current id (no-op)", () => {
    const target = computeTargetSlug("sunset-beach", "vid-sunset-beach", new Set());
    expect(target).toBe("vid-sunset-beach");
  });
});

describe("buildRenameRows", () => {
  const assets = [
    { asset_id: "vid-aaa123", type: "video", context_text: "a dog running on the beach" },
    { asset_id: "img-bbb456", type: "image", context_text: "neon portrait of a fox" },
  ];
  const allIds = ["vid-aaa123", "img-bbb456", "vid-other"];

  it("builds renamable rows from suggestions", () => {
    const suggestions = {
      "vid-aaa123": "dog beach run",
      "img-bbb456": "neon fox",
    };
    const rows = buildRenameRows(assets, suggestions, allIds);
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("renamable");
    expect(rows[0].target_asset_id).toBe("vid-dog-beach-run");
    expect(rows[0].current_name).toBe("Aaa123");
    expect(rows[1].target_asset_id).toBe("img-neon-fox");
  });

  it("marks rows with no suggestion as skipped", () => {
    const rows = buildRenameRows(assets, {}, allIds);
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].reason).toBe("No suggestion produced");
  });

  it("marks unchanged when normalized slug equals current id", () => {
    const suggestions = { "vid-aaa123": "aaa123" };
    const rows = buildRenameRows([assets[0]], suggestions, ["vid-aaa123"]);
    expect(rows[0].status).toBe("unchanged");
    expect(rows[0].target_asset_id).toBe("vid-aaa123");
  });

  it("suffixes when two suggestions collide", () => {
    const assets2 = [
      { asset_id: "vid-a1", type: "video", context_text: "x" },
      { asset_id: "vid-a2", type: "video", context_text: "x" },
    ];
    const suggestions = { "vid-a1": "sunset", "vid-a2": "sunset" };
    const rows = buildRenameRows(assets2, suggestions, ["vid-a1", "vid-a2", "vid-other"]);
    expect(rows[0].target_asset_id).toBe("vid-sunset");
    expect(rows[1].target_asset_id).toBe("vid-sunset-2");
  });

  it("preserves short img-nbp- mnemonic when the model omits it", () => {
    const assetsNbp = [
      { asset_id: "img-nbp-updat-ethe-device", type: "image", context_text: "green gadget" },
    ];
    const rows = buildRenameRows(
      assetsNbp,
      { "img-nbp-updat-ethe-device": "green device" },
      ["img-nbp-updat-ethe-device"],
    );
    expect(rows[0].suggested_name).toBe("nbp green device");
    expect(rows[0].target_asset_id).toBe("img-nbp-green-device");
  });

  it("does not duplicate an already-present mnemonic", () => {
    const assetsNbp = [
      { asset_id: "img-nbp-clear-table", type: "image", context_text: "table" },
    ];
    const rows = buildRenameRows(
      assetsNbp,
      { "img-nbp-clear-table": "nbp table" },
      ["img-nbp-clear-table"],
    );
    expect(rows[0].suggested_name).toBe("nbp table");
    expect(rows[0].target_asset_id).toBe("img-nbp-table");
  });
});

describe("leadingMnemonicTokens / withPreservedMnemonic", () => {
  it("extracts nbp and mmm-style codes", () => {
    expect(leadingMnemonicTokens("img-nbp-updat-ethe-device")).toEqual(["nbp"]);
    expect(leadingMnemonicTokens("img-mmm")).toEqual(["mmm"]);
    expect(leadingMnemonicTokens("vid-google-omni-locked-off")).toEqual([]);
    expect(leadingMnemonicTokens("img-replace-device-image")).toEqual([]);
  });

  it("prepends missing mnemonic once", () => {
    expect(withPreservedMnemonic("green device", "img-nbp-old")).toBe("nbp green device");
    expect(withPreservedMnemonic("nbp device", "img-nbp-old")).toBe("nbp device");
  });
});

describe("validateEditedRenames", () => {
  it("marks renamable when target is free", () => {
    const rows = validateEditedRenames(
      [{ asset_id: "vid-old1", suggested_name: "sunset beach" }],
      ["vid-old1", "img-keep"],
    );
    expect(rows[0].status).toBe("renamable");
    expect(rows[0].target_asset_id).toBe("vid-sunset-beach");
  });

  it("marks conflict when target collides with another existing asset", () => {
    const rows = validateEditedRenames(
      [{ asset_id: "vid-old1", suggested_name: "sunset beach" }],
      ["vid-old1", "vid-sunset-beach"],
    );
    expect(rows[0].status).toBe("conflict");
  });

  it("marks conflict when asset no longer exists", () => {
    const rows = validateEditedRenames(
      [{ asset_id: "vid-gone", suggested_name: "whatever" }],
      ["vid-other"],
    );
    expect(rows[0].status).toBe("conflict");
    expect(rows[0].reason).toBe("Asset no longer exists");
  });

  it("marks conflict on empty name", () => {
    const rows = validateEditedRenames(
      [{ asset_id: "vid-old1", suggested_name: "   " }],
      ["vid-old1"],
    );
    expect(rows[0].status).toBe("conflict");
    expect(rows[0].reason).toBe("Empty name");
  });

  it("marks unchanged when normalized slug matches current", () => {
    const rows = validateEditedRenames(
      [{ asset_id: "vid-sunset-beach", suggested_name: "sunset beach" }],
      ["vid-sunset-beach"],
    );
    expect(rows[0].status).toBe("unchanged");
  });

  it("suffixes collisions between two edits targeting the same slug", () => {
    const rows = validateEditedRenames(
      [
        { asset_id: "vid-a1", suggested_name: "sunset" },
        { asset_id: "vid-a2", suggested_name: "sunset" },
      ],
      ["vid-a1", "vid-a2"],
    );
    expect(rows[0].target_asset_id).toBe("vid-sunset");
    expect(rows[1].target_asset_id).toBe("vid-sunset-2");
    expect(rows[1].status).toBe("renamable");
  });
});

describe("applyableRows", () => {
  it("filters to renamable only", () => {
    const rows = [
      { asset_id: "a", type: "video" as const, current_slug: "a", current_name: "A", suggested_name: "b", target_asset_id: "vid-b", status: "renamable" as const },
      { asset_id: "c", type: "image" as const, current_slug: "c", current_name: "C", suggested_name: "", target_asset_id: "c", status: "skipped" as const },
    ];
    expect(applyableRows(rows)).toHaveLength(1);
  });
});

describe("isProcessOrigin", () => {
  it("flags pipeline labels that must not drive names", () => {
    expect(isProcessOrigin("last_frame")).toBe(true);
    expect(isProcessOrigin("first_frame")).toBe(true);
    expect(isProcessOrigin("external")).toBe(true);
    expect(isProcessOrigin("user-upload")).toBe(false);
  });
});

describe("buildSuggestionPrompt", () => {
  it("lists each asset id, type, and context snippet", () => {
    const text = buildSuggestionPrompt([
      { asset_id: "vid-beach-run", type: "video", context_text: "a dog running" },
    ]);
    expect(text).toContain("vid-beach-run (video)");
    expect(text).toContain("a dog running");
    expect(text).toContain("JSON object");
    expect(text).toContain("last frame");
    expect(text).toContain("VISUAL content");
    expect(text).toContain("1–2 content words");
  });

  it("marks keep tokens for short mnemonics like nbp", () => {
    const text = buildSuggestionPrompt([
      { asset_id: "img-nbp-updat-ethe-device", type: "image", context_text: "gadget" },
    ]);
    expect(text).toContain("keep token: nbp");
    expect(text).toContain("MUST start");
  });

  it("truncates long context to 700 chars", () => {
    const long = "x".repeat(900);
    const text = buildSuggestionPrompt([
      { asset_id: "vid-abc", type: "video", context_text: long },
    ]);
    expect(text).toContain("x".repeat(700));
    expect(text).not.toContain("x".repeat(701));
  });

  it("notes missing text context and optional preview images", () => {
    const text = buildSuggestionPrompt(
      [{ asset_id: "img-empty", type: "image", context_text: "" }],
      { hasImages: true },
    );
    expect(text).toContain("no text context");
    expect(text).toContain("Preview images follow");
  });
});

describe("parseSuggestionResponse", () => {
  it("parses a plain JSON object", () => {
    const out = parseSuggestionResponse('{"vid-a": "sunset beach"}');
    expect(out).toEqual({ "vid-a": "sunset beach" });
  });

  it("parses JSON inside a code fence", () => {
    const out = parseSuggestionResponse('```json\n{"vid-a": "fox"}\n```');
    expect(out).toEqual({ "vid-a": "fox" });
  });

  it("parses JSON embedded in prose", () => {
    const out = parseSuggestionResponse('Here you go:\n{"vid-a": "fox"}\nDone!');
    expect(out).toEqual({ "vid-a": "fox" });
  });

  it("returns empty map on unparseable input", () => {
    expect(parseSuggestionResponse("no json here")).toEqual({});
    expect(parseSuggestionResponse("}invalid{")).toEqual({});
  });

  it("ignores non-string values", () => {
    const out = parseSuggestionResponse('{"vid-a": "fox", "vid-b": 123}');
    expect(out).toEqual({ "vid-a": "fox" });
  });
});

describe("rewriteTimelineReferences", () => {
  it("rewrites slot and audio slugs", () => {
    const config = {
      slots: [{ slug: "vid-old" }, { slug: "vid-keep" }],
      audio: [{ slug: "aud-keep" }, { slug: "vid-old" }],
    };
    const idMap = new Map([["vid-old", "vid-new"]]);
    rewriteTimelineReferences(config, idMap);
    expect(config.slots[0].slug).toBe("vid-new");
    expect(config.slots[1].slug).toBe("vid-keep");
    expect(config.audio[1].slug).toBe("vid-new");
  });

  it("leaves unmatched slugs untouched", () => {
    const config = { slots: [{ slug: "vid-other" }] };
    rewriteTimelineReferences(config, new Map([["vid-old", "vid-new"]]));
    expect(config.slots[0].slug).toBe("vid-other");
  });
});

describe("rewriteDeep", () => {
  it("rewrites string values anywhere in a nested structure", () => {
    const plan = {
      source_asset_id: "vid-old",
      characters: [{ asset_id: "img-old", name: "Fox" }],
      scenes: [{ swap: { image1: "img-old", image2_variants: { a: "vid-old" } } }],
    };
    const idMap = new Map([
      ["vid-old", "vid-new"],
      ["img-old", "img-new"],
    ]);
    rewriteDeep(plan, idMap);
    expect(plan.source_asset_id).toBe("vid-new");
    expect(plan.characters[0].asset_id).toBe("img-new");
    expect(plan.scenes[0].swap.image1).toBe("img-new");
    expect(plan.scenes[0].swap.image2_variants.a).toBe("vid-new");
  });

  it("leaves unmatched strings untouched", () => {
    const obj = { a: "vid-keep", b: ["img-keep"] };
    rewriteDeep(obj, new Map([["vid-old", "vid-new"]]));
    expect(obj.a).toBe("vid-keep");
    expect(obj.b[0]).toBe("img-keep");
  });
});

// ---------------------------------------------------------------------------
// MCP tool integration tests (apply path needs no OpenAI key)
// ---------------------------------------------------------------------------

describe("rename_all tool", () => {
  let client: Client;
  let tempDir: string;
  const origKey = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    if (origKey) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("dry run returns error when OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await client.callTool({
      name: "rename_all",
      arguments: { book_id: "test-proj", dry_run: true },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("dry run reports no renamable assets when project is empty", async () => {
    process.env.OPENAI_API_KEY = "test-key-for-validation";
    const result = await client.callTool({
      name: "rename_all",
      arguments: { book_id: "test-proj", dry_run: true },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.rows).toEqual([]);
  });

  it("apply requires a non-empty renames array", async () => {
    const result = await client.callTool({
      name: "rename_all",
      arguments: { book_id: "test-proj", dry_run: false },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("non-empty");
  });

  it("apply with no renamable rows returns an error", async () => {
    const result = await client.callTool({
      name: "rename_all",
      arguments: {
        book_id: "test-proj",
        dry_run: false,
        renames: [{ asset_id: "vid-nonexistent", suggested_name: "whatever" }],
      },
    });
    expect(result.isError).toBe(true);
  });

  it("dry run with edited renames revalidates without calling OpenAI", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await client.callTool({
      name: "rename_all",
      arguments: {
        book_id: "test-proj",
        dry_run: true,
        renames: [{ asset_id: "vid-nope", suggested_name: "anything" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.rows[0].status).toBe("conflict");
  });

  it("dry run does NOT rename any assets", async () => {
    // Upload an image to create a real asset, then dry-run revalidation against it.
    const data = Buffer.from("fake-png").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse((uploadResult.content as TextContent)[0].text);

    // Wait for the auto process_image job to leave 'working' state so rename is allowed.
    const deadline = Date.now() + 8000;
    const assetId = uploaded.assetId as string;
    while (Date.now() < deadline) {
      const beforeList = await client.callTool({
        name: "list_assets",
        arguments: { book_id: "test-proj" },
      });
      const beforeAssets = JSON.parse((beforeList.content as TextContent)[0].text).assets;
      const found = beforeAssets.find((a: { id: string }) => a.id === assetId);
      if (found && found.status !== "working") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const result = await client.callTool({
      name: "rename_all",
      arguments: {
        book_id: "test-proj",
        dry_run: true,
        renames: [{ asset_id: assetId, suggested_name: "sunset beach" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.rows[0].status).toBe("renamable");
    expect(parsed.rows[0].target_asset_id).toBe("img-sunset-beach");

    // The original asset must still exist unchanged.
    const afterList = await client.callTool({
      name: "list_assets",
      arguments: { book_id: "test-proj" },
    });
    const afterAssets = JSON.parse((afterList.content as TextContent)[0].text).assets;
    expect(afterAssets.some((a: { id: string }) => a.id === assetId)).toBe(true);
    expect(afterAssets.some((a: { id: string }) => a.id === "img-sunset-beach")).toBe(false);
  });

  it("apply renames assets and reports the new ids", async () => {
    const data = Buffer.from("fake-png").toString("base64");
    const upload1 = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "a.png", data },
    });
    const id1 = JSON.parse((upload1.content as TextContent)[0].text).assetId as string;

    // Wait for the working lease to release on both assets.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const list = await client.callTool({
        name: "list_assets",
        arguments: { book_id: "test-proj" },
      });
      const assets = JSON.parse((list.content as TextContent)[0].text).assets;
      const found = assets.find((a: { id: string }) => a.id === id1);
      if (found && found.status !== "working") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const result = await client.callTool({
      name: "rename_all",
      arguments: {
        book_id: "test-proj",
        dry_run: false,
        renames: [{ asset_id: id1, suggested_name: "sunset beach" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.dry_run).toBe(false);
    expect(parsed.applied[0].renamed).toBe(true);
    expect(parsed.applied[0].new_asset_id).toBe("img-sunset-beach");

    // Old id gone, new id present.
    const afterList = await client.callTool({
      name: "list_assets",
      arguments: { book_id: "test-proj" },
    });
    const afterAssets = JSON.parse((afterList.content as TextContent)[0].text).assets;
    expect(afterAssets.some((a: { id: string }) => a.id === id1)).toBe(false);
    expect(afterAssets.some((a: { id: string }) => a.id === "img-sunset-beach")).toBe(true);
  });

  it("apply updates timeline slot references", async () => {
    const data = Buffer.from("fake-png").toString("base64");
    const upload = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "t.png", data },
    });
    const id = JSON.parse((upload.content as TextContent)[0].text).assetId as string;

    // Wait for working lease to release.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const list = await client.callTool({
        name: "list_assets",
        arguments: { book_id: "test-proj" },
      });
      const assets = JSON.parse((list.content as TextContent)[0].text).assets;
      const found = assets.find((a: { id: string }) => a.id === id);
      if (found && found.status !== "working") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Assign the asset to a timeline slot, then rename it.
    await client.callTool({
      name: "assign_slot",
      arguments: { book_id: "test-proj", slot: "s01", asset_id: id },
    });

    const result = await client.callTool({
      name: "rename_all",
      arguments: {
        book_id: "test-proj",
        dry_run: false,
        renames: [{ asset_id: id, suggested_name: "sunset beach" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.references_updated).toBe(true);
    expect(parsed.applied[0].new_asset_id).toBe("img-sunset-beach");

    // Timeline should now reference the new id.
    const timelineResult = await client.callTool({
      name: "get_timeline",
      arguments: { book_id: "test-proj" },
    });
    const timeline = JSON.parse((timelineResult.content as TextContent)[0].text);
    const slots = timeline.slots ?? [];
    expect(slots[0]?.slug).toBe("img-sunset-beach");
  });

  it("apply rewrites normalized notebook @-references and bare output ids", async () => {
    const data = Buffer.from("fake-png").toString("base64");
    const upload = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "plan.png", data },
    });
    const assetId = JSON.parse((upload.content as TextContent)[0].text).assetId as string;

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const list = await client.callTool({
        name: "list_assets",
        arguments: { book_id: "test-proj" },
      });
      const assets = JSON.parse((list.content as TextContent)[0].text).assets;
      const found = assets.find((asset: { id: string; status: string }) => asset.id === assetId);
      if (found && found.status !== "working") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const fsObj = createEngineForTest(tempDir);
    const notebook = await fsObj.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    const saved = await fsObj.notebooks.write({
      ...notebook.value,
      cells: [{
          id: "image-1",
          type: "image",
          title: "Key frame",
          slot: { row: 0, column: 0 },
          inputs: {
            model: "nano-banana-pro",
            values: {
              prompt: `Match the lighting of @${assetId} exactly.`,
              image_slugs: [`@${assetId}`],
              first_frame_slug: `@${assetId}`,
            },
            inputs: ["asset-source"],
            asset_ids: [assetId],
          },
        }, {
          id: "asset-source",
          type: "image",
          title: "Source",
          slot: { row: 0, column: 1 },
          inputs: { slug: `@${assetId}` },
        }],
      edges: [{
        id: "asset-source:image-1",
        source: "asset-source",
        target: "image-1",
        targetInput: "input-0",
      }],
    });
    expect(saved.ok).toBe(true);

    const result = await client.callTool({
      name: "rename_all",
      arguments: {
        book_id: "test-proj",
        dry_run: false,
        renames: [{ asset_id: assetId, suggested_name: "sunset beach" }],
      },
    });

    expect(result.isError).toBeFalsy();
    const renamed = "img-sunset-beach";
    const updated = fsObj.notebooks.read(notebook.value.id);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const imageInputs = updated.value.cells[0].inputs as {
      values: Record<string, unknown>;
      asset_ids: string[];
    };
    expect(imageInputs.values.image_slugs).toEqual([`@${renamed}`]);
    expect(imageInputs.values.first_frame_slug).toBe(`@${renamed}`);
    expect(imageInputs.asset_ids).toEqual([renamed]);
    expect(imageInputs.values.prompt).toBe(
      `Match the lighting of @${renamed} exactly.`,
    );
    expect(updated.value.cells[1].inputs?.slug).toBe(`@${renamed}`);
  });
});
