/**
 * Integration tests for render with subtitles across orientations.
 *
 * Split out of render-orientation-settings.test.ts so vitest can run this
 * 66-test block in parallel with the rest of the file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFs } from "clipfirst-engine";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

function parseResult(result: { content?: unknown; toolResult?: unknown }): Record<string, unknown> {
  let content: unknown;
  if (result.content) {
    content = result.content;
  } else if (result.toolResult) {
    const toolResult = result.toolResult as { content?: TextContent } | undefined;
    content = toolResult?.content;
  }
  return JSON.parse((content as TextContent)[0].text);
}

const ORIENTATIONS = ["landscape", "portrait", "square"] as const;
const HIGHLIGHT_STYLES = ["impact", "highlight"] as const;
const POSITIONS = ["top", "middle", "bottom"] as const;
const FONT_SIZES = ["small", "medium", "large"] as const;
const BACKGROUND_MODES = ["blur", "black"] as const;

let client: Client;
let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "clipfirst-orient-subs-"));
  client = await createTestClient(tempDir);
  await client.callTool({
    name: "create_project",
    arguments: { project_slug: "jazzy-salmon-95" },
  });
});

afterAll(async () => {
  await client?.close();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
});

describe("render orientation: video with subtitles", () => {
  for (const orientation of ORIENTATIONS) {
    describe(`orientation=${orientation}`, () => {
      for (const highlight_style of HIGHLIGHT_STYLES) {
        for (const position of POSITIONS) {
          for (const font_size of FONT_SIZES) {
            it(`style=${highlight_style} pos=${position} font=${font_size}`, async () => {
              const suffix = `${orientation}-${highlight_style}-${position}-${font_size}`;
              const fs = createFs({ projectsDir: tempDir });
              const asset = await fs.createAsset("vid", `recipe2-${suffix}`, "jazzy-salmon-95");
              if (!asset.ok) throw new Error("Failed to create asset");
              await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
              await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

              await fs.writeProjectMeta("timeline", {
                slots: [{ slug: asset.value.assetId }],
                render: orientation,
              }, "jazzy-salmon-95");

              const result = await client.callTool({
                name: "render",
                arguments: {
                  asset_id: asset.value.assetId,
                  project_slug: "jazzy-salmon-95",
                  subtitles_enabled: true,
                  highlight_style,
                  position,
                  font_size,
                },
              });
              expect(result.isError).toBeFalsy();
              const parsed = parseResult(result);
              expect(parsed.orientations).toContain(orientation);
              expect(parsed.status).toBe("enqueued");
            });
          }
        }
      }

      for (const background_mode of BACKGROUND_MODES) {
        it(`subs+background=${background_mode}`, async () => {
          const fs = createFs({ projectsDir: tempDir });
          const asset = await fs.createAsset("vid", `recipe2-${orientation}-bg-${background_mode}`, "jazzy-salmon-95");
          if (!asset.ok) throw new Error("Failed to create asset");
          await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
          await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

          await fs.writeProjectMeta("timeline", {
            slots: [{ slug: asset.value.assetId }],
            render: orientation,
          }, "jazzy-salmon-95");

          const result = await client.callTool({
            name: "render",
            arguments: {
              asset_id: asset.value.assetId,
              project_slug: "jazzy-salmon-95",
              subtitles_enabled: true,
              background_mode,
            },
          });
          expect(result.isError).toBeFalsy();
          expect(parseResult(result).orientations).toContain(orientation);
        });
      }

      it("custom colors: textColor=#00FF00 highlightColor=#FF00FF", async () => {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", `recipe2-${orientation}-colors`, "jazzy-salmon-95");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
        await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

        await fs.writeProjectMeta("timeline", {
          slots: [{ slug: asset.value.assetId }],
          render: orientation,
        }, "jazzy-salmon-95");

        const result = await client.callTool({
          name: "render",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "jazzy-salmon-95",
            subtitles_enabled: true,
            text_color: "#00FF00",
            highlight_color: "#FF00FF",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).orientations).toContain(orientation);
      });

      it("default colors: textColor=#F8FAFC highlightColor=#991B1B", async () => {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", `recipe2-${orientation}-defcolors`, "jazzy-salmon-95");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
        await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

        await fs.writeProjectMeta("timeline", {
          slots: [{ slug: asset.value.assetId }],
          render: orientation,
        }, "jazzy-salmon-95");

        const result = await client.callTool({
          name: "render",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "jazzy-salmon-95",
            subtitles_enabled: true,
            text_color: "#F8FAFC",
            highlight_color: "#991B1B",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).orientations).toContain(orientation);
      });
    });
  }
});
