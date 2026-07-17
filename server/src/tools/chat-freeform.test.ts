/**
 * Freeform chat command tests — exercises the chat tool's pre-routing pipeline
 * with many different natural language inputs.
 *
 * Tests cover: slot expansion, asset resolution, error handling, and edge cases
 * for inputs that users might type as freeform commands.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFs } from "videocity-engine";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

function resultText(result: { content?: unknown; toolResult?: unknown }): string {
  if (result.content) {
    return (result.content as TextContent)[0].text;
  }
  // Handle error results that have toolResult instead of content
  const toolResult = result.toolResult as { content?: TextContent } | undefined;
  if (toolResult?.content) {
    return toolResult.content[0].text;
  }
  return "";
}

// Single shared client/project across the suite. Per-test `beforeEach` setup
// (mkdtemp + createTestClient + create_project) was timing out the 60s hook
// budget under parallel load — every createTestClient call stomps the queue's
// global projectsDir, so concurrent suites can race each other into ENOENT.
// Pinning everything to `beforeAll` removes that contention.
describe("freeform chat commands", () => {
  let client: Client;
  let tempDir: string;
  const origKey = process.env.KIE_API_KEY;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-freeform-chat-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
    // Clear API key so we can test up to the routing boundary
    delete process.env.KIE_API_KEY;
  });

  afterAll(async () => {
    if (origKey) process.env.KIE_API_KEY = origKey;
    else delete process.env.KIE_API_KEY;
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  // -----------------------------------------------------------------------
  // Freeform prompts without @tags — should reach API key check
  // -----------------------------------------------------------------------

  describe("plain freeform prompts (no @tags)", () => {
    const prompts = [
      "download https://youtube.com/watch?v=abc123",
      "download with playwright",
      "trim the first 10 seconds",
      "reverse the video",
      "extract audio from the clip",
      "speed up 2x",
      "generate a video of a cat skateboarding",
      "generate an image of a sunset over mountains",
      "transcribe this",
      "list all assets",
      "list my projects",
      "make it slower",
      "timewarp the first 4.2 seconds by 1.5x",
      "show me the first frame",
      "get the last frame",
      "what videos do I have",
      "create a 30 second highlight reel",
    ];

    for (const prompt of prompts) {
      it(`routes "${prompt}" past asset resolution to API key check`, async () => {
        const result = await client.callTool({
          name: "chat",
          arguments: { prompt, project_slug: "test-proj" },
        });
        // No @tags to resolve, so should reach the API key check
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain("KIE_API_KEY");
      });
    }
  });

  // -----------------------------------------------------------------------
  // Freeform prompts with valid @tags — should resolve then hit API check
  // -----------------------------------------------------------------------

  describe("freeform prompts with valid @asset tags", () => {
    let assetId: string;

    beforeAll(async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "sunset.png", data },
      });
      const parsed = JSON.parse(resultText(upload));
      assetId = parsed.assetId;
    });

    it("resolves @tag in 'trim @img-sunset from 0 to 5'", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: `trim @${assetId} from 0 to 5`,
          project_slug: "test-proj",
        },
      });
      // Asset resolved successfully, hits API key check
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
      expect(resultText(result)).not.toContain("Asset not found");
    });

    it("resolves @tag in 'reverse @img-sunset'", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: `reverse @${assetId}`,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
      expect(resultText(result)).not.toContain("Asset not found");
    });

    it("resolves @tag in 'extract audio from @img-sunset'", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: `extract audio from @${assetId}`,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
    });

    it("resolves @tag in 'speed up @img-sunset 2x'", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: `speed up @${assetId} 2x`,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
    });

    it("resolves @tag in 'transcribe @img-sunset'", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: `transcribe @${assetId}`,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
    });

    it("resolves @tag in 'show files for @img-sunset'", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: `show files for @${assetId}`,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
    });
  });

  // -----------------------------------------------------------------------
  // Freeform prompts with invalid @tags — should error with "Asset not found"
  // -----------------------------------------------------------------------

  describe("freeform prompts with invalid @tags", () => {
    it("errors for 'trim @nonexistent-video from 5 to 10'", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: "trim @nonexistent-video from 5 to 10",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Asset not found");
      expect(resultText(result)).toContain("@nonexistent-video");
    });

    it("errors for 'reverse @fake-clip'", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: "reverse @fake-clip",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Asset not found");
    });

    it("errors for 'combine @alpha-clip and @beta-clip' (both invalid)", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: "combine @alpha-clip and @beta-clip",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("@alpha-clip");
      expect(resultText(result)).toContain("@beta-clip");
    });

    it("errors for mixed valid and invalid: 'merge @real-asset and @fake-asset'", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "real.png", data },
      });
      const parsed = JSON.parse(resultText(upload));

      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: `merge @${parsed.assetId} and @fake-asset`,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Asset not found");
      expect(resultText(result)).toContain("@fake-asset");
    });
  });

  // -----------------------------------------------------------------------
  // Slot reference expansion in freeform prompts
  // -----------------------------------------------------------------------

  describe("slot ref expansion in freeform prompts", () => {
    let assetId: string;

    // beforeEach (not All) — assign_slot mutates project state and the
    // "@s02 unassigned" test wants a clean baseline.
    beforeEach(async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "clip.png", data },
      });
      assetId = JSON.parse(resultText(upload)).assetId;

      await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s01" },
      });
    });

    it("expands @s01 and resolves the underlying asset", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: "trim @s01 from 5 to 10",
          project_slug: "test-proj",
        },
      });
      // @s01 → @asset-id → resolves → hits API check
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
      expect(resultText(result)).not.toContain("Asset not found");
    });

    it("expands @s01 in 'reverse @s01'", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: "reverse @s01",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
      expect(resultText(result)).not.toContain("Asset not found");
    });

    it("errors for @s02 when only 1 slot is assigned", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: "trim @s02 from 0 to 5",
          project_slug: "test-proj",
        },
      });
      // @s02 stays as @s02 (no slot at index 2), asset resolver may or may not find it
      // The slot has no asset, so @s02 might remain unexpanded
      // s02 doesn't match the TAG_PATTERN /@([a-zA-Z0-9]+-[a-zA-Z0-9_-]+)/g
      // because "s02" has no hyphen. So it passes through with no assets to resolve.
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
    });

    it("expands @s01 in 'extract first frame of @s01'", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: "extract first frame of @s01",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
      expect(resultText(result)).not.toContain("Asset not found");
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases and special characters
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles empty-ish prompt (whitespace only)", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: { prompt: "   ", project_slug: "test-proj" },
      });
      // Empty prompt should still reach API key check (no assets to resolve)
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
    });

    it("handles prompt with only a URL", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
    });

    it("handles prompt with special characters (no @tags)", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: 'generate "a cinematic sunset" with (golden hour) & lens flare!',
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
    });

    it("handles @-sign without valid tag pattern (e.g. email)", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: "send to user@example.com",
          project_slug: "test-proj",
        },
      });
      // "@example" doesn't match TAG_PATTERN /@([a-zA-Z0-9]+-[a-zA-Z0-9_-]+)/
      // because "example.com" has a dot, not matching the pattern
      // Should pass through to API key check
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
    });

    it("handles single-word @tag that has no hyphen (ignored by resolver)", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: "use @singleword in the video",
          project_slug: "test-proj",
        },
      });
      // TAG_PATTERN requires a hyphen: /@([a-zA-Z0-9]+-[a-zA-Z0-9_-]+)/
      // "@singleword" has no hyphen, so it's not parsed as a tag
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
    });

    it("handles numeric timestamps in freeform without @tags", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: "download https://example.com/video from 1:30 to 2:45",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
    });

    it("handles prompt that looks like a command but isn't (starts with /)", async () => {
      // The chat tool receives the full prompt including the / if sent from
      // the chat fallback path
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: "/generate a cool video of mountains",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
    });

    it("handles very long prompt without @tags", async () => {
      const longPrompt = "generate a cinematic video " + "with lots of detail ".repeat(50);
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: longPrompt,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
    });
  });

  // -----------------------------------------------------------------------
  // Multiple assets in a single freeform prompt
  // -----------------------------------------------------------------------

  describe("multiple assets in freeform prompts", () => {
    let asset1: string;
    let asset2: string;

    beforeAll(async () => {
      const data = Buffer.from("fake-data").toString("base64");
      const u1 = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "clip-a.png", data },
      });
      const u2 = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "clip-b.png", data },
      });
      asset1 = JSON.parse(resultText(u1)).assetId;
      asset2 = JSON.parse(resultText(u2)).assetId;
    });

    it("resolves two @tags in one prompt", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: `combine @${asset1} and @${asset2}`,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
      expect(resultText(result)).not.toContain("Asset not found");
    });

    it("errors when one of two @tags is invalid", async () => {
      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: `merge @${asset1} with @nonexistent-clip`,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Asset not found");
      expect(resultText(result)).toContain("@nonexistent-clip");
    });
  });

  // -----------------------------------------------------------------------
  // Script asset handling in freeform prompts
  // -----------------------------------------------------------------------

  describe("script asset in freeform prompts", () => {
    it("resolves @script-tag for generation prompts", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const scriptResult = await fs.createAsset("script", "my-scene", "test-proj");
      if (!scriptResult.ok) throw new Error("Failed to create script asset");
      await fs.writeFile(scriptResult.value.assetId, "original.md", "A beautiful sunset over the ocean", "test-proj");

      const result = await client.callTool({
        name: "chat",
        arguments: {
          prompt: `generate a video from @${scriptResult.value.assetId}`,
          project_slug: "test-proj",
        },
      });
      // Script resolved, hits API key check
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("KIE_API_KEY");
      expect(resultText(result)).not.toContain("Asset not found");
    });
  });
});
