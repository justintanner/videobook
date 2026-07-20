import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createFs } from "videocity-engine";
import { createTestClient } from "../test-client.js";
import { readWatermarkConfig } from "../watermark-config.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

const PROJECT = "watermark-proj";

function resultText(result: { content?: unknown; toolResult?: unknown }): string {
  if (result.content) return (result.content as TextContent)[0].text;
  const toolResult = result.toolResult as { content?: TextContent } | undefined;
  return toolResult?.content?.[0]?.text ?? "";
}

describe("create_watermark tool", () => {
  let client: Client | undefined;
  let tempDir: string;
  let fs: ReturnType<typeof createFs>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    tempDir = await mkdtemp(join(tmpdir(), "videocity-create-watermark-"));
    // Isolate the remembered-handle store to this temp dir.
    process.env.WATERMARK_CONFIG_PATH = join(tempDir, "watermark-config.json");
    // Isolate from ambient X credentials to prevent outbound API calls
    process.env.X_TOKENS_PATH = join(tempDir, "x-tokens.json");
    delete process.env.X_ACCESS_TOKEN;
    
    fs = createFs({ projectsDir: tempDir });
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: PROJECT },
    });
  });

  afterEach(async () => {
    await client?.close();
    process.env = originalEnv;
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("creates a ready img- asset holding the QR card", async () => {
    const result = await client!.callTool({
      name: "create_watermark",
      arguments: { project_slug: PROJECT, handle: "@someone" },
    });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(resultText(result)) as {
      asset_id: string;
      handle: string;
      url: string;
    };
    expect(parsed.asset_id).toMatch(/^img-/);
    expect(parsed.handle).toBe("someone");
    expect(parsed.url).toBe("https://x.com/someone");

    const manifest = await fs.getManifest(parsed.asset_id, PROJECT, { includeDotfiles: true });
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const fileNames = new Set(manifest.value.files.map((file) => file.name));
    expect(fileNames.has("original.png")).toBe(true);
    expect(fileNames.has("landscape.jpg")).toBe(true);
    expect(fileNames.has("portrait.jpg")).toBe(true);
    expect(fileNames.has("square.jpg")).toBe(true);

    const read = await fs.readFile(parsed.asset_id, "original.png", PROJECT);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const buffer = Buffer.isBuffer(read.value) ? read.value : Buffer.from(read.value);
    const metadata = await sharp(buffer).metadata();
    // TILE 272 (QR 240 + 2*TILE_PAD 16) + 2*OUTER_PAD 24 = 320 wide;
    // OUTER_PAD 24 + HEADER 40 + GAP 18 + TILE 272 + OUTER_PAD 24 = 378 tall.
    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(378);
  });

  it("defaults the handle and derives the X URL", async () => {
    const result = await client!.callTool({
      name: "create_watermark",
      arguments: { project_slug: PROJECT },
    });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(resultText(result)) as { handle: string; url: string };
    expect(parsed.handle).toBe("justinwtanner");
    expect(parsed.url).toBe("https://x.com/justinwtanner");
  });

  it("remembers used handles and the saved default", async () => {
    await client!.callTool({
      name: "create_watermark",
      arguments: { project_slug: PROJECT, handle: "alice", save_default: true },
    });
    await client!.callTool({
      name: "create_watermark",
      arguments: { project_slug: PROJECT, handle: "@bob" },
    });

    // Most-recent-first; saved default stays pinned to the save_default handle.
    const config = await readWatermarkConfig();
    expect(config.recent).toEqual(["bob", "alice"]);
    expect(config.savedHandle).toBe("alice");

    // get_watermark_config exposes the same state to the client.
    const cfgResult = await client!.callTool({
      name: "get_watermark_config",
      arguments: {},
    });
    expect(cfgResult.isError).not.toBe(true);
    const exposed = JSON.parse(resultText(cfgResult)) as { savedHandle: string | null; recent: string[]; authenticatedHandle: string | null };
    expect(exposed.savedHandle).toBe("alice");
    expect(exposed.recent).toEqual(["bob", "alice"]);
    // authenticatedHandle is null in tests because no X access token is configured.
    expect(exposed.authenticatedHandle).toBeNull();
  });
});
