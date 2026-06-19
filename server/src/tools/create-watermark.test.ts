import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createFs } from "videocity-engine";
import { createTestClient } from "../test-client.js";
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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-create-watermark-"));
    fs = createFs({ projectsDir: tempDir });
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: PROJECT },
    });
  });

  afterEach(async () => {
    await client?.close();
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
    // QR_SIZE 240 + 2*PADDING 12 = 264 wide; + TEXT_BAND 40 = 304 tall.
    expect(metadata.width).toBe(264);
    expect(metadata.height).toBe(304);
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
});
