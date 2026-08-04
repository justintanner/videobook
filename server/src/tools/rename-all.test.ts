import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";
import {
  RENAME_KINDS,
  isRenamableKind,
  buildRenameRows,
  validateEditedRenames,
  applyableRows,
  buildSuggestionPrompt,
  parseSuggestionResponse,
  isProcessOrigin,
  type AssetContext,
  type RenameCandidate,
  type RenameRow,
} from "../rename-helpers.js";

type TextContent = Array<{ type: string; text: string }>;

// Artifact ids are UUIDv7 and are never derived from — or changed by — a
// rename. These constants stand in for live artifacts in the pure unit tests.
const VIDEO_ID = "01890f1c-0000-7000-8000-0000000000a1";
const IMAGE_ID = "01890f1c-0000-7000-8000-0000000000a2";
const SECOND_VIDEO_ID = "01890f1c-0000-7000-8000-0000000000a3";
const AUDIO_ID = "01890f1c-0000-7000-8000-0000000000a4";
/** A well-formed artifact id that never exists in these fixtures. */
const MISSING_ID = "01890f1c-0000-7000-8000-0000000000ff";

// ---------------------------------------------------------------------------
// Pure helper unit tests
// ---------------------------------------------------------------------------

describe("isRenamableKind", () => {
  it("accepts only the video and image kinds", () => {
    expect(RENAME_KINDS).toEqual(["video", "image"]);
    expect(isRenamableKind("video")).toBe(true);
    expect(isRenamableKind("image")).toBe(true);
    expect(isRenamableKind("audio")).toBe(false);
    expect(isRenamableKind("character")).toBe(false);
    expect(isRenamableKind("script")).toBe(false);
  });
});

describe("buildRenameRows", () => {
  const assets: AssetContext[] = [
    {
      asset_id: VIDEO_ID,
      type: "video",
      label: "beach run",
      context_text: "a dog running on the beach",
    },
    {
      asset_id: IMAGE_ID,
      type: "image",
      label: "fox",
      context_text: "neon portrait of a fox",
    },
  ];

  it("builds renamable rows from suggestions", () => {
    const rows = buildRenameRows(assets, {
      [VIDEO_ID]: "dog beach run",
      [IMAGE_ID]: "neon fox",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      asset_id: VIDEO_ID,
      type: "video",
      current_name: "beach run",
      suggested_name: "dog beach run",
      status: "renamable",
    });
    expect(rows[1]).toEqual({
      asset_id: IMAGE_ID,
      type: "image",
      current_name: "fox",
      suggested_name: "neon fox",
      status: "renamable",
    });
  });

  it("falls back to the artifact id as the current name when unlabeled", () => {
    const unlabeled: AssetContext[] = [
      { asset_id: VIDEO_ID, type: "video", context_text: "a dog running" },
    ];
    const rows = buildRenameRows(unlabeled, { [VIDEO_ID]: "dog beach run" });
    expect(rows[0].current_name).toBe(VIDEO_ID);
    expect(rows[0].status).toBe("renamable");
  });

  it("marks rows with no suggestion as skipped", () => {
    const rows = buildRenameRows(assets, {});
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].reason).toBe("No suggestion produced");
    expect(rows[0].suggested_name).toBe("beach run");
  });

  it("marks a blank suggestion as skipped", () => {
    const rows = buildRenameRows([assets[0]], { [VIDEO_ID]: "   " });
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].reason).toBe("No suggestion produced");
  });

  it("marks unchanged when the suggestion equals the current label", () => {
    const rows = buildRenameRows([assets[0]], { [VIDEO_ID]: "beach run" });
    expect(rows[0].status).toBe("unchanged");
    expect(rows[0].reason).toBe("Label already matches");
    expect(rows[0].suggested_name).toBe("beach run");
  });

  it("lets two assets share one label — labels are not unique", () => {
    const twoVideos: AssetContext[] = [
      { asset_id: VIDEO_ID, type: "video", context_text: "x" },
      { asset_id: SECOND_VIDEO_ID, type: "video", context_text: "x" },
    ];
    const rows = buildRenameRows(twoVideos, {
      [VIDEO_ID]: "sunset",
      [SECOND_VIDEO_ID]: "sunset",
    });
    expect(rows[0].suggested_name).toBe("sunset");
    expect(rows[1].suggested_name).toBe("sunset");
    expect(rows.map((row) => row.status)).toEqual(["renamable", "renamable"]);
  });
});

describe("validateEditedRenames", () => {
  const candidates: RenameCandidate[] = [
    { artifactId: VIDEO_ID, label: "beach run", kind: "video" },
    { artifactId: IMAGE_ID, kind: "image" },
    { artifactId: AUDIO_ID, label: "theme", kind: "audio" },
  ];

  it("marks renamable when the edited label differs from the current one", () => {
    const rows = validateEditedRenames(
      [{ asset_id: VIDEO_ID, suggested_name: "  sunset beach  " }],
      candidates,
    );
    expect(rows[0]).toEqual({
      asset_id: VIDEO_ID,
      type: "video",
      current_name: "beach run",
      suggested_name: "sunset beach",
      status: "renamable",
    });
  });

  it("falls back to the artifact id as the current name when unlabeled", () => {
    const rows = validateEditedRenames(
      [{ asset_id: IMAGE_ID, suggested_name: "neon fox" }],
      candidates,
    );
    expect(rows[0].current_name).toBe(IMAGE_ID);
    expect(rows[0].status).toBe("renamable");
  });

  it("marks conflict when asset no longer exists", () => {
    const rows = validateEditedRenames(
      [{ asset_id: MISSING_ID, suggested_name: "whatever" }],
      candidates,
    );
    expect(rows[0].status).toBe("conflict");
    expect(rows[0].reason).toBe("Asset no longer exists");
  });

  it("marks conflict for a kind that is not renamable here", () => {
    const rows = validateEditedRenames(
      [{ asset_id: AUDIO_ID, suggested_name: "new theme" }],
      candidates,
    );
    expect(rows[0].status).toBe("conflict");
    expect(rows[0].reason).toBe(
      "Only video and image assets are renamable here (got audio)",
    );
  });

  it("marks conflict on empty name", () => {
    const rows = validateEditedRenames(
      [{ asset_id: VIDEO_ID, suggested_name: "   " }],
      candidates,
    );
    expect(rows[0].status).toBe("conflict");
    expect(rows[0].reason).toBe("Empty name");
  });

  it("marks unchanged when the label already matches", () => {
    const rows = validateEditedRenames(
      [{ asset_id: VIDEO_ID, suggested_name: "beach run" }],
      candidates,
    );
    expect(rows[0].status).toBe("unchanged");
    expect(rows[0].reason).toBe("Label already matches");
  });

  it("lets two edits target the same label — labels are not unique", () => {
    const rows = validateEditedRenames(
      [
        { asset_id: VIDEO_ID, suggested_name: "sunset" },
        { asset_id: IMAGE_ID, suggested_name: "sunset" },
      ],
      candidates,
    );
    expect(rows.map((row) => row.suggested_name)).toEqual(["sunset", "sunset"]);
    expect(rows.map((row) => row.status)).toEqual(["renamable", "renamable"]);
  });
});

describe("applyableRows", () => {
  it("filters to renamable only", () => {
    const rows: RenameRow[] = [
      {
        asset_id: VIDEO_ID,
        type: "video",
        current_name: "beach run",
        suggested_name: "sunset beach",
        status: "renamable",
      },
      {
        asset_id: IMAGE_ID,
        type: "image",
        current_name: IMAGE_ID,
        suggested_name: IMAGE_ID,
        status: "skipped",
        reason: "No suggestion produced",
      },
      {
        asset_id: SECOND_VIDEO_ID,
        type: "video",
        current_name: "sunset",
        suggested_name: "sunset",
        status: "unchanged",
        reason: "Label already matches",
      },
    ];
    expect(applyableRows(rows)).toEqual([rows[0]]);
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
      { asset_id: VIDEO_ID, type: "video", context_text: "a dog running" },
    ]);
    expect(text).toContain(`${VIDEO_ID} (video)`);
    expect(text).toContain("a dog running");
    expect(text).toContain("JSON object");
    expect(text).toContain("last frame");
    expect(text).toContain("VISUAL content");
    expect(text).toContain("1–2 content words");
  });

  it("includes the current display label when the asset has one", () => {
    const text = buildSuggestionPrompt([
      {
        asset_id: IMAGE_ID,
        type: "image",
        label: "green device",
        context_text: "gadget",
      },
    ]);
    expect(text).toContain(`${IMAGE_ID} (image; current label: green device)`);
  });

  it("truncates long context to 700 chars", () => {
    const long = "x".repeat(900);
    const text = buildSuggestionPrompt([
      { asset_id: VIDEO_ID, type: "video", context_text: long },
    ]);
    expect(text).toContain("x".repeat(700));
    expect(text).not.toContain("x".repeat(701));
  });

  it("notes missing text context and optional preview images", () => {
    const text = buildSuggestionPrompt(
      [{ asset_id: IMAGE_ID, type: "image", context_text: "" }],
      { hasImages: true },
    );
    expect(text).toContain("no text context");
    expect(text).toContain("Preview images follow");
  });
});

describe("parseSuggestionResponse", () => {
  it("parses a plain JSON object", () => {
    const out = parseSuggestionResponse(`{"${VIDEO_ID}": "sunset beach"}`);
    expect(out).toEqual({ [VIDEO_ID]: "sunset beach" });
  });

  it("parses JSON inside a code fence", () => {
    const out = parseSuggestionResponse(`\`\`\`json\n{"${VIDEO_ID}": "fox"}\n\`\`\``);
    expect(out).toEqual({ [VIDEO_ID]: "fox" });
  });

  it("parses JSON embedded in prose", () => {
    const out = parseSuggestionResponse(
      `Here you go:\n{"${VIDEO_ID}": "fox"}\nDone!`,
    );
    expect(out).toEqual({ [VIDEO_ID]: "fox" });
  });

  it("returns empty map on unparseable input", () => {
    expect(parseSuggestionResponse("no json here")).toEqual({});
    expect(parseSuggestionResponse("}invalid{")).toEqual({});
  });

  it("ignores non-string values", () => {
    const out = parseSuggestionResponse(
      `{"${VIDEO_ID}": "fox", "${IMAGE_ID}": 123}`,
    );
    expect(out).toEqual({ [VIDEO_ID]: "fox" });
  });
});

// ---------------------------------------------------------------------------
// MCP tool integration tests (apply path needs no OpenAI key)
// ---------------------------------------------------------------------------

interface AppliedRename {
  asset_id: string;
  label: string;
  renamed: boolean;
  error?: string;
}

interface AssetRow {
  id: string;
  artifact_id: string;
  label?: string;
  status: string;
}

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

  async function listAssets(): Promise<AssetRow[]> {
    const list = await client.callTool({
      name: "list_assets",
      arguments: { book_id: "test-proj" },
    });
    return JSON.parse((list.content as TextContent)[0].text).assets as AssetRow[];
  }

  async function uploadImage(filename: string): Promise<string> {
    const data = Buffer.from("fake-png").toString("base64");
    const upload = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename, data },
    });
    const uploaded = JSON.parse((upload.content as TextContent)[0].text) as {
      artifactId: string;
    };
    return uploaded.artifactId;
  }

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
        renames: [{ asset_id: MISSING_ID, suggested_name: "whatever" }],
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
        renames: [{ asset_id: MISSING_ID, suggested_name: "anything" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.rows[0].status).toBe("conflict");
    expect(parsed.rows[0].reason).toBe("Asset no longer exists");
  });

  it("dry run does NOT relabel any assets", async () => {
    // Uploading photo.png labels the new artifact "photo".
    const assetId = await uploadImage("photo.png");

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
    expect(parsed.rows[0].asset_id).toBe(assetId);
    expect(parsed.rows[0].current_name).toBe("photo");
    expect(parsed.rows[0].suggested_name).toBe("sunset beach");

    // The artifact keeps both its id and its original label.
    const after = await listAssets();
    const row = after.find((asset) => asset.id === assetId);
    expect(row).toBeDefined();
    expect(row?.label).toBe("photo");
  });

  it("apply relabels assets and keeps their artifact ids", async () => {
    const assetId = await uploadImage("a.png");

    const result = await client.callTool({
      name: "rename_all",
      arguments: {
        book_id: "test-proj",
        dry_run: false,
        renames: [{ asset_id: assetId, suggested_name: "sunset beach" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text) as {
      dry_run: boolean;
      applied: AppliedRename[];
    };
    expect(parsed.dry_run).toBe(false);
    expect(parsed.applied).toEqual([
      { asset_id: assetId, label: "sunset beach", renamed: true },
    ]);

    // Renaming is display-only: the id is unchanged and only the label moves.
    const after = await listAssets();
    const row = after.find((asset) => asset.id === assetId);
    expect(row).toBeDefined();
    expect(row?.artifact_id).toBe(assetId);
    expect(row?.label).toBe("sunset beach");
  });

  it("apply relabels several assets in one batch, duplicate labels included", async () => {
    const firstId = await uploadImage("one.png");
    const secondId = await uploadImage("two.png");

    const result = await client.callTool({
      name: "rename_all",
      arguments: {
        book_id: "test-proj",
        dry_run: false,
        renames: [
          { asset_id: firstId, suggested_name: "sunset" },
          { asset_id: secondId, suggested_name: "sunset" },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text) as {
      applied: AppliedRename[];
    };
    expect(parsed.applied).toEqual([
      { asset_id: firstId, label: "sunset", renamed: true },
      { asset_id: secondId, label: "sunset", renamed: true },
    ]);

    const after = await listAssets();
    const labels = [firstId, secondId].map(
      (id) => after.find((asset) => asset.id === id)?.label,
    );
    expect(labels).toEqual(["sunset", "sunset"]);
  });
});
