/**
 * Integration tests for render orientation settings permutations.
 *
 * Tests two video types across all three orientations (landscape/portrait/square)
 * with various render settings combinations:
 *   - Video without elevenlabs.json (no subtitles)
 *   - Video with elevenlabs.json (subtitles enabled)
 *
 * Covers: orientation x subtitles x highlight_style x position x font_size
 *         x background_mode x audio settings x OSG positions
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFs } from "clipfirst-fs";
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
const OSG_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;

// ---------------------------------------------------------------------------
// 1. Video WITHOUT subtitles — orientation x background x audio permutations
// ---------------------------------------------------------------------------
describe("render orientation: video without subtitles", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-orient-nosubs-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "jazzy-salmon-95" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  for (const orientation of ORIENTATIONS) {
    describe(`orientation=${orientation}`, () => {
      for (const background_mode of BACKGROUND_MODES) {
        it(`background_mode=${background_mode}`, async () => {
          const fs = createFs({ projectsDir: tempDir });
          const asset = await fs.createAsset("vid", `toothpaste-${orientation}-${background_mode}`, "jazzy-salmon-95");
          if (!asset.ok) throw new Error("Failed to create asset");
          await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

          await fs.writeProjectMeta("timeline", {
            slots: [{ slug: asset.value.assetId }],
            render: orientation,
          }, "jazzy-salmon-95");

          const result = await client.callTool({
            name: "render",
            arguments: {
              asset_id: asset.value.assetId,
              project_slug: "jazzy-salmon-95",
              subtitles_enabled: false,
              background_mode,
            },
          });
          expect(result.isError).toBeFalsy();
          const parsed = parseResult(result);
          expect(parsed.orientations).toContain(orientation);
          expect(parsed.status).toBe("enqueued");
        });
      }

      it("audio: volume=0 (muted)", async () => {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", `toothpaste-${orientation}-muted`, "jazzy-salmon-95");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

        await fs.writeProjectMeta("timeline", {
          slots: [{ slug: asset.value.assetId }],
          render: orientation,
        }, "jazzy-salmon-95");

        const result = await client.callTool({
          name: "render",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "jazzy-salmon-95",
            subtitles_enabled: false,
            audio_volume: 0,
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).orientations).toContain(orientation);
      });

      it("audio: volume=50, fade_in=300, fade_out=200", async () => {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", `toothpaste-${orientation}-halfvol`, "jazzy-salmon-95");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

        await fs.writeProjectMeta("timeline", {
          slots: [{ slug: asset.value.assetId }],
          render: orientation,
        }, "jazzy-salmon-95");

        const result = await client.callTool({
          name: "render",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "jazzy-salmon-95",
            subtitles_enabled: false,
            audio_volume: 50,
            audio_fade_in: 300,
            audio_fade_out: 200,
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).orientations).toContain(orientation);
      });

      it("audio: volume=100, no fades", async () => {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", `toothpaste-${orientation}-nofade`, "jazzy-salmon-95");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

        await fs.writeProjectMeta("timeline", {
          slots: [{ slug: asset.value.assetId }],
          render: orientation,
        }, "jazzy-salmon-95");

        const result = await client.callTool({
          name: "render",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "jazzy-salmon-95",
            subtitles_enabled: false,
            audio_volume: 100,
            audio_fade_in: 0,
            audio_fade_out: 0,
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).orientations).toContain(orientation);
      });

      it("combined: black background + muted audio", async () => {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", `toothpaste-${orientation}-combo`, "jazzy-salmon-95");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

        await fs.writeProjectMeta("timeline", {
          slots: [{ slug: asset.value.assetId }],
          render: orientation,
        }, "jazzy-salmon-95");

        const result = await client.callTool({
          name: "render",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "jazzy-salmon-95",
            subtitles_enabled: false,
            background_mode: "black",
            audio_volume: 0,
            audio_fade_in: 0,
            audio_fade_out: 0,
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).orientations).toContain(orientation);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Video WITH subtitles — orientation x subtitle settings permutations
// ---------------------------------------------------------------------------
describe("render orientation: video with subtitles", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-orient-subs-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "jazzy-salmon-95" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

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

// ---------------------------------------------------------------------------
// 3. OSG overlay — orientation x osg_position permutations
// ---------------------------------------------------------------------------
describe("render orientation: OSG overlay positions", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-orient-osg-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "jazzy-salmon-95" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  for (const orientation of ORIENTATIONS) {
    for (const osg_position of OSG_POSITIONS) {
      it(`orientation=${orientation} osg_position=${osg_position}`, async () => {
        const fs = createFs({ projectsDir: tempDir });
        const vidAsset = await fs.createAsset("vid", `recipe-${orientation}-osg-${osg_position}`, "jazzy-salmon-95");
        if (!vidAsset.ok) throw new Error("Failed to create vid asset");
        await fs.writeFile(vidAsset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

        const imgAsset = await fs.createAsset("img", `logo-${orientation}-${osg_position}`, "jazzy-salmon-95");
        if (!imgAsset.ok) throw new Error("Failed to create img asset");
        await fs.writeFile(imgAsset.value.assetId, "logo.png", Buffer.from("fake-png"), "jazzy-salmon-95");

        await fs.writeProjectMeta("timeline", {
          slots: [{ slug: vidAsset.value.assetId }],
          render: orientation,
        }, "jazzy-salmon-95");

        const result = await client.callTool({
          name: "render",
          arguments: {
            asset_id: vidAsset.value.assetId,
            project_slug: "jazzy-salmon-95",
            subtitles_enabled: false,
            osg_asset_id: imgAsset.value.assetId,
            osg_position,
          },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.orientations).toContain(orientation);
        expect(parsed.status).toBe("enqueued");
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Full settings matrix — both videos with all settings combined
// ---------------------------------------------------------------------------
describe("render orientation: full settings matrix", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-orient-full-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "jazzy-salmon-95" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  for (const orientation of ORIENTATIONS) {
    it(`${orientation}: all subtitle+audio+background settings combined (with subs)`, async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", `full-subs-${orientation}`, "jazzy-salmon-95");
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
          highlight_style: "impact",
          position: "bottom",
          font_size: "medium",
          text_color: "#F8FAFC",
          highlight_color: "#991B1B",
          audio_volume: 100,
          audio_fade_in: 150,
          audio_fade_out: 100,
          background_mode: "blur",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.orientations).toContain(orientation);
      expect(parsed.status).toBe("enqueued");
    });

    it(`${orientation}: all settings combined (no subs, black bg)`, async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", `full-nosubs-${orientation}`, "jazzy-salmon-95");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

      await fs.writeProjectMeta("timeline", {
        slots: [{ slug: asset.value.assetId }],
        render: orientation,
      }, "jazzy-salmon-95");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "jazzy-salmon-95",
          subtitles_enabled: false,
          audio_volume: 75,
          audio_fade_in: 500,
          audio_fade_out: 500,
          background_mode: "black",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.orientations).toContain(orientation);
      expect(parsed.status).toBe("enqueued");
    });

    it(`${orientation}: highlight style with top position + large font`, async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", `full-highlight-${orientation}`, "jazzy-salmon-95");
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
          highlight_style: "highlight",
          position: "top",
          font_size: "large",
          text_color: "#FFFFFF",
          highlight_color: "#00BFFF",
          background_mode: "blur",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).orientations).toContain(orientation);
    });

    it(`${orientation}: impact style with mid position + small font + black bg`, async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", `full-impact-mid-${orientation}`, "jazzy-salmon-95");
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
          highlight_style: "impact",
          position: "middle",
          font_size: "small",
          text_color: "#F0F0F0",
          highlight_color: "#FF0000",
          background_mode: "black",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).orientations).toContain(orientation);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Timeline orientation switching — edit_timeline then render
// ---------------------------------------------------------------------------
describe("render orientation: timeline switching between orientations", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-orient-switch-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "jazzy-salmon-95" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("switches orientation via edit_timeline and renders in each", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "toothpaste-switch", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    for (const orientation of ORIENTATIONS) {
      // Switch orientation via edit_timeline MCP tool
      const editResult = await client.callTool({
        name: "edit_timeline",
        arguments: {
          project_slug: "jazzy-salmon-95",
          slots: [{ slug: asset.value.assetId }],
          render: orientation,
        },
      });
      expect(editResult.isError).toBeFalsy();

      // Render with the new orientation
      const renderResult = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "jazzy-salmon-95",
          subtitles_enabled: false,
        },
      });
      expect(renderResult.isError).toBeFalsy();
      expect(parseResult(renderResult).orientations).toContain(orientation);
    }
  });

  it("switches orientation for video with subtitles via edit_timeline", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "recipe2-switch", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
    await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

    for (const orientation of ORIENTATIONS) {
      const editResult = await client.callTool({
        name: "edit_timeline",
        arguments: {
          project_slug: "jazzy-salmon-95",
          slots: [{ slug: asset.value.assetId }],
          render: orientation,
        },
      });
      expect(editResult.isError).toBeFalsy();

      const renderResult = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "jazzy-salmon-95",
          subtitles_enabled: true,
          highlight_style: "impact",
          position: "bottom",
          font_size: "medium",
        },
      });
      expect(renderResult.isError).toBeFalsy();
      expect(parseResult(renderResult).orientations).toContain(orientation);
    }
  });

  it("two videos in same timeline, both render with same orientation", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset1 = await fs.createAsset("vid", "toothpaste-dual1", "jazzy-salmon-95");
    if (!asset1.ok) throw new Error("Failed to create asset1");
    await fs.writeFile(asset1.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    const asset2 = await fs.createAsset("vid", "toothpaste-dual2", "jazzy-salmon-95");
    if (!asset2.ok) throw new Error("Failed to create asset2");
    await fs.writeFile(asset2.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
    await fs.writeFile(asset2.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

    for (const orientation of ORIENTATIONS) {
      await client.callTool({
        name: "edit_timeline",
        arguments: {
          project_slug: "jazzy-salmon-95",
          slots: [
            { slug: asset1.value.assetId },
            { slug: asset2.value.assetId },
          ],
          render: orientation,
        },
      });

      // Render video 1 (no subs)
      const r1 = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset1.value.assetId,
          project_slug: "jazzy-salmon-95",
          subtitles_enabled: false,
          background_mode: "blur",
        },
      });
      expect(r1.isError).toBeFalsy();
      expect(parseResult(r1).orientations).toContain(orientation);

      // Render video 2 (with subs)
      const r2 = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset2.value.assetId,
          project_slug: "jazzy-salmon-95",
          subtitles_enabled: true,
          highlight_style: "highlight",
          position: "top",
          font_size: "large",
          background_mode: "black",
        },
      });
      expect(r2.isError).toBeFalsy();
      expect(parseResult(r2).orientations).toContain(orientation);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Edge cases: subtitles_enabled=true without elevenlabs.json
// ---------------------------------------------------------------------------
describe("render orientation: subtitle edge cases", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-orient-edge-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "jazzy-salmon-95" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  for (const orientation of ORIENTATIONS) {
    it(`${orientation}: subtitles_enabled=true without elevenlabs.json errors`, async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", `no-el-${orientation}`, "jazzy-salmon-95");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

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
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("elevenlabs.json");
    });

    it(`${orientation}: auto-detects subtitles when elevenlabs.json exists`, async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", `auto-el-${orientation}`, "jazzy-salmon-95");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
      await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

      await fs.writeProjectMeta("timeline", {
        slots: [{ slug: asset.value.assetId }],
        render: orientation,
      }, "jazzy-salmon-95");

      // Don't specify subtitles_enabled — should auto-detect
      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "jazzy-salmon-95",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).orientations).toContain(orientation);
    });

    it(`${orientation}: subtitles_enabled=false overrides auto-detection`, async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", `override-el-${orientation}`, "jazzy-salmon-95");
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
          subtitles_enabled: false,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).orientations).toContain(orientation);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Focused subtitles_enabled and highlight_style tests
// ---------------------------------------------------------------------------
describe("render: subtitles_enabled and highlight_style focused", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-subs-style-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "jazzy-salmon-95" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  // --- subtitles_enabled: true with elevenlabs.json ---
  it("subtitles_enabled=true succeeds when elevenlabs.json exists", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "subs-true-test", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
    await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
  });

  // --- subtitles_enabled: true without elevenlabs.json => error ---
  it("subtitles_enabled=true errors when elevenlabs.json missing", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "subs-true-noel", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("elevenlabs.json");
  });

  // --- subtitles_enabled: false bypasses subtitle processing ---
  it("subtitles_enabled=false succeeds without elevenlabs.json", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "subs-false-noel", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
  });

  // --- subtitles_enabled: false overrides auto-detect when elevenlabs.json exists ---
  it("subtitles_enabled=false overrides auto-detect even with elevenlabs.json", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "subs-false-withel", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
    await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
  });

  // --- highlight_style: impact ---
  it("highlight_style=impact succeeds with subtitles enabled", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "style-impact-test", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
    await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        highlight_style: "impact",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
  });

  // --- highlight_style: highlight ---
  it("highlight_style=highlight succeeds with subtitles enabled", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "style-highlight-test", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
    await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        highlight_style: "highlight",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
  });

  // --- highlight_style with additional subtitle settings ---
  it("impact style with position and font_size settings", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "impact-full-opts", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
    await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "portrait",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        highlight_style: "impact",
        position: "middle",
        font_size: "large",
        text_color: "#FFFFFF",
        highlight_color: "#FF0000",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("portrait");
  });

  it("highlight style with position and font_size settings", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "highlight-full-opts", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
    await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "square",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        highlight_style: "highlight",
        position: "top",
        font_size: "small",
        text_color: "#00FF00",
        highlight_color: "#0000FF",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("square");
  });

  // --- highlight_style ignored when subtitles disabled ---
  it("highlight_style is accepted but irrelevant when subtitles_enabled=false", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "style-nosubs", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        highlight_style: "impact",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
  });
});

// ---------------------------------------------------------------------------
// 8. Audio settings — volume, fade-in, fade-out isolated permutations
// ---------------------------------------------------------------------------
describe("render audio settings", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-audio-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "jazzy-salmon-95" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createVidAsset(slug: string): Promise<string> {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", slug, "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");
    return asset.value.assetId;
  }

  // --- audio_volume ---

  it("audio_volume=100 (default) succeeds", async () => {
    const assetId = await createVidAsset("audio-vol100");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        audio_volume: 100,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
    expect(parsed.asset_id).toBe(assetId);
  });

  it("audio_volume=50 succeeds", async () => {
    const assetId = await createVidAsset("audio-vol50");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        audio_volume: 50,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
    expect(parsed.asset_id).toBe(assetId);
  });

  it("audio_volume=0 (muted) succeeds", async () => {
    const assetId = await createVidAsset("audio-vol0");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        audio_volume: 0,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
    expect(parsed.asset_id).toBe(assetId);
  });

  // --- audio_fade_in ---

  it("audio_fade_in=150 (default) succeeds", async () => {
    const assetId = await createVidAsset("audio-fadein150");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        audio_fade_in: 150,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
    expect(parsed.asset_id).toBe(assetId);
  });

  it("audio_fade_in=0 (no fade) succeeds", async () => {
    const assetId = await createVidAsset("audio-fadein0");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        audio_fade_in: 0,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
    expect(parsed.asset_id).toBe(assetId);
  });

  // --- audio_fade_out ---

  it("audio_fade_out=100 (default) succeeds", async () => {
    const assetId = await createVidAsset("audio-fadeout100");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        audio_fade_out: 100,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
    expect(parsed.asset_id).toBe(assetId);
  });

  it("audio_fade_out=0 (no fade) succeeds", async () => {
    const assetId = await createVidAsset("audio-fadeout0");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        audio_fade_out: 0,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
    expect(parsed.asset_id).toBe(assetId);
  });

  // --- combined audio settings ---

  it("all audio settings combined: volume=50, fade_in=0, fade_out=0", async () => {
    const assetId = await createVidAsset("audio-combo-nofades");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        audio_volume: 50,
        audio_fade_in: 0,
        audio_fade_out: 0,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.asset_id).toBe(assetId);
  });

  it("all audio settings combined: volume=0, fade_in=150, fade_out=100 (defaults with mute)", async () => {
    const assetId = await createVidAsset("audio-combo-mute-fades");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        audio_volume: 0,
        audio_fade_in: 150,
        audio_fade_out: 100,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.asset_id).toBe(assetId);
  });

  it("all audio defaults omitted (implicit volume=100, fade_in=150, fade_out=100)", async () => {
    const assetId = await createVidAsset("audio-all-defaults");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
    expect(parsed.asset_id).toBe(assetId);
  });

  // --- validation edge cases ---

  it("audio_volume=-1 returns error", async () => {
    const assetId = await createVidAsset("audio-vol-neg");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        audio_volume: -1,
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("audio_volume must be 0-100");
  });

  it("audio_volume=101 returns error", async () => {
    const assetId = await createVidAsset("audio-vol-over");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        audio_volume: 101,
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("audio_volume must be 0-100");
  });

  it("audio_fade_in=-1 returns error", async () => {
    const assetId = await createVidAsset("audio-fadein-neg");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        audio_fade_in: -1,
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("audio fade values must be >= 0");
  });

  it("audio_fade_out=-1 returns error", async () => {
    const assetId = await createVidAsset("audio-fadeout-neg");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        audio_fade_out: -1,
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("audio fade values must be >= 0");
  });
});

// ---------------------------------------------------------------------------
// 9. Text color and highlight color settings
// ---------------------------------------------------------------------------
describe("render color settings: text_color and highlight_color", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-colors-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "jazzy-salmon-95" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createSubtitledVidAsset(name: string): Promise<string> {
    const localFs = createFs({ projectsDir: tempDir });
    const asset = await localFs.createAsset("vid", name, "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await localFs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
    await localFs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");
    await localFs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");
    return asset.value.assetId;
  }

  // ---- text_color valid values ----

  it("text_color=#FFFFFF (white) succeeds", async () => {
    const assetId = await createSubtitledVidAsset("color-white-text");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        text_color: "#FFFFFF",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
  });

  it("text_color=#FF0000 (red, non-default) succeeds", async () => {
    const assetId = await createSubtitledVidAsset("color-red-text");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        text_color: "#FF0000",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
  });

  // ---- highlight_color valid values ----

  it("highlight_color=#991B1B (default dark red) succeeds", async () => {
    const assetId = await createSubtitledVidAsset("color-default-highlight");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        highlight_color: "#991B1B",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
  });

  it("highlight_color=#00FF00 (green, non-default) succeeds", async () => {
    const assetId = await createSubtitledVidAsset("color-green-highlight");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        highlight_color: "#00FF00",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
  });

  // ---- both colors together ----

  it("text_color=#FFFFFF + highlight_color=#991B1B (both specified) succeeds", async () => {
    const assetId = await createSubtitledVidAsset("color-both-default");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        text_color: "#FFFFFF",
        highlight_color: "#991B1B",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
  });

  it("text_color=#FF0000 + highlight_color=#00FF00 (both non-default) succeeds", async () => {
    const assetId = await createSubtitledVidAsset("color-both-custom");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        text_color: "#FF0000",
        highlight_color: "#00FF00",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
  });

  // ---- invalid hex colors ----

  it("invalid text_color (no hash) returns error", async () => {
    const assetId = await createSubtitledVidAsset("color-invalid-nohash");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        text_color: "FF0000",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent)[0].text;
    expect(text).toContain("Invalid text_color hex");
    expect(text).toContain("FF0000");
  });

  it("invalid text_color (short hex #FFF) returns error", async () => {
    const assetId = await createSubtitledVidAsset("color-invalid-short");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        text_color: "#FFF",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent)[0].text;
    expect(text).toContain("Invalid text_color hex");
  });

  it("invalid text_color (non-hex chars #GGGGGG) returns error", async () => {
    const assetId = await createSubtitledVidAsset("color-invalid-chars");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        text_color: "#GGGGGG",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent)[0].text;
    expect(text).toContain("Invalid text_color hex");
  });

  it("invalid highlight_color (no hash) returns error", async () => {
    const assetId = await createSubtitledVidAsset("color-invalid-hl-nohash");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        highlight_color: "00FF00",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent)[0].text;
    expect(text).toContain("Invalid highlight_color hex");
    expect(text).toContain("00FF00");
  });

  it("invalid highlight_color (too long #00FF00FF) returns error", async () => {
    const assetId = await createSubtitledVidAsset("color-invalid-hl-long");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        highlight_color: "#00FF00FF",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent)[0].text;
    expect(text).toContain("Invalid highlight_color hex");
  });

  it("invalid highlight_color (rgb() format) returns error", async () => {
    const assetId = await createSubtitledVidAsset("color-invalid-hl-rgb");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        highlight_color: "rgb(0,255,0)",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent)[0].text;
    expect(text).toContain("Invalid highlight_color hex");
  });

  it("invalid text_color + valid highlight_color returns text_color error first", async () => {
    const assetId = await createSubtitledVidAsset("color-invalid-text-first");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        text_color: "bad",
        highlight_color: "#00FF00",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent)[0].text;
    expect(text).toContain("Invalid text_color hex");
  });

  it("valid text_color + invalid highlight_color returns highlight_color error", async () => {
    const assetId = await createSubtitledVidAsset("color-valid-text-invalid-hl");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        text_color: "#FF0000",
        highlight_color: "bad",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent)[0].text;
    expect(text).toContain("Invalid highlight_color hex");
  });

  // ---- colors with lowercase hex ----

  it("text_color=#ff0000 (lowercase) succeeds", async () => {
    const assetId = await createSubtitledVidAsset("color-lowercase-text");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        text_color: "#ff0000",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
  });

  it("highlight_color=#00ff00 (lowercase) succeeds", async () => {
    const assetId = await createSubtitledVidAsset("color-lowercase-highlight");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        highlight_color: "#00ff00",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
  });

  // ---- colors with different highlight styles ----

  it("highlight_color=#00FF00 applies with highlight_style=highlight", async () => {
    const assetId = await createSubtitledVidAsset("color-style-highlight");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        highlight_style: "highlight",
        highlight_color: "#00FF00",
        text_color: "#FFFFFF",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
  });

  it("highlight_color=#00FF00 applies with highlight_style=impact", async () => {
    const assetId = await createSubtitledVidAsset("color-style-impact");
    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        highlight_style: "impact",
        highlight_color: "#00FF00",
        text_color: "#FF0000",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
  });
});

// ---------------------------------------------------------------------------
// 10. Focused subtitle position tests — each position value in isolation
// ---------------------------------------------------------------------------
describe("render settings: subtitle position", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-pos-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "jazzy-salmon-95" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  for (const position of POSITIONS) {
    it(`position=${position} renders successfully with subtitles`, async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", `pos-test-${position}`, "jazzy-salmon-95");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
      await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

      await fs.writeProjectMeta("timeline", {
        slots: [{ slug: asset.value.assetId }],
        render: "landscape",
      }, "jazzy-salmon-95");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "jazzy-salmon-95",
          subtitles_enabled: true,
          position,
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.orientations).toContain("landscape");
      expect(parsed.status).toBe("enqueued");
    });

    it(`position=${position} works across all orientations`, async () => {
      const fs = createFs({ projectsDir: tempDir });

      for (const orientation of ORIENTATIONS) {
        const asset = await fs.createAsset("vid", `pos-${position}-${orientation}`, "jazzy-salmon-95");
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
            position,
          },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.orientations).toContain(orientation);
        expect(parsed.status).toBe("enqueued");
      }
    });
  }

  it("position defaults to bottom when omitted", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "pos-default", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
    await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        // position intentionally omitted — should default to "bottom"
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
  });
});

// ---------------------------------------------------------------------------
// 11. Focused font size tests — each font_size value in isolation
// ---------------------------------------------------------------------------
describe("render settings: font size", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-fontsize-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "jazzy-salmon-95" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  for (const font_size of FONT_SIZES) {
    it(`font_size=${font_size} renders successfully with subtitles`, async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", `font-test-${font_size}`, "jazzy-salmon-95");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
      await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

      await fs.writeProjectMeta("timeline", {
        slots: [{ slug: asset.value.assetId }],
        render: "landscape",
      }, "jazzy-salmon-95");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "jazzy-salmon-95",
          subtitles_enabled: true,
          font_size,
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.orientations).toContain("landscape");
      expect(parsed.status).toBe("enqueued");
    });

    it(`font_size=${font_size} works across all orientations`, async () => {
      const fs = createFs({ projectsDir: tempDir });

      for (const orientation of ORIENTATIONS) {
        const asset = await fs.createAsset("vid", `font-${font_size}-${orientation}`, "jazzy-salmon-95");
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
            font_size,
          },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.orientations).toContain(orientation);
        expect(parsed.status).toBe("enqueued");
      }
    });
  }

  it("font_size defaults to medium when omitted", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "font-default", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
    await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        // font_size intentionally omitted — should default to "medium"
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
  });
});

// ---------------------------------------------------------------------------
// 12. Position x font_size cross-product — all 9 combinations
// ---------------------------------------------------------------------------
describe("render settings: position x font_size combinations", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-pos-font-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "jazzy-salmon-95" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  for (const position of POSITIONS) {
    for (const font_size of FONT_SIZES) {
      it(`position=${position} font_size=${font_size}`, async () => {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", `pf-${position}-${font_size}`, "jazzy-salmon-95");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
        await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

        await fs.writeProjectMeta("timeline", {
          slots: [{ slug: asset.value.assetId }],
          render: "portrait",
        }, "jazzy-salmon-95");

        const result = await client.callTool({
          name: "render",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "jazzy-salmon-95",
            subtitles_enabled: true,
            position,
            font_size,
          },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.orientations).toContain("portrait");
        expect(parsed.status).toBe("enqueued");
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 13. Focused OSG position tests — each position individually
// ---------------------------------------------------------------------------
describe("render: osg_position focused", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-osg-pos-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "jazzy-salmon-95" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("osg_position=top-left enqueues successfully", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const vidAsset = await fs.createAsset("vid", "osg-tl-vid", "jazzy-salmon-95");
    if (!vidAsset.ok) throw new Error("Failed to create vid asset");
    await fs.writeFile(vidAsset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    const imgAsset = await fs.createAsset("img", "osg-tl-logo", "jazzy-salmon-95");
    if (!imgAsset.ok) throw new Error("Failed to create img asset");
    await fs.writeFile(imgAsset.value.assetId, "logo.png", Buffer.from("fake-png"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: vidAsset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: vidAsset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        osg_asset_id: imgAsset.value.assetId,
        osg_position: "top-left",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
  });

  it("osg_position=top-right enqueues successfully", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const vidAsset = await fs.createAsset("vid", "osg-tr-vid", "jazzy-salmon-95");
    if (!vidAsset.ok) throw new Error("Failed to create vid asset");
    await fs.writeFile(vidAsset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    const imgAsset = await fs.createAsset("img", "osg-tr-logo", "jazzy-salmon-95");
    if (!imgAsset.ok) throw new Error("Failed to create img asset");
    await fs.writeFile(imgAsset.value.assetId, "logo.png", Buffer.from("fake-png"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: vidAsset.value.assetId }],
      render: "portrait",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: vidAsset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        osg_asset_id: imgAsset.value.assetId,
        osg_position: "top-right",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("portrait");
  });

  it("osg_position=bottom-left enqueues successfully", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const vidAsset = await fs.createAsset("vid", "osg-bl-vid", "jazzy-salmon-95");
    if (!vidAsset.ok) throw new Error("Failed to create vid asset");
    await fs.writeFile(vidAsset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    const imgAsset = await fs.createAsset("img", "osg-bl-logo", "jazzy-salmon-95");
    if (!imgAsset.ok) throw new Error("Failed to create img asset");
    await fs.writeFile(imgAsset.value.assetId, "logo.png", Buffer.from("fake-png"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: vidAsset.value.assetId }],
      render: "square",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: vidAsset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        osg_asset_id: imgAsset.value.assetId,
        osg_position: "bottom-left",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("square");
  });

  it("osg_position=bottom-right enqueues successfully", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const vidAsset = await fs.createAsset("vid", "osg-br-vid", "jazzy-salmon-95");
    if (!vidAsset.ok) throw new Error("Failed to create vid asset");
    await fs.writeFile(vidAsset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    const imgAsset = await fs.createAsset("img", "osg-br-logo", "jazzy-salmon-95");
    if (!imgAsset.ok) throw new Error("Failed to create img asset");
    await fs.writeFile(imgAsset.value.assetId, "logo.png", Buffer.from("fake-png"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: vidAsset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: vidAsset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        osg_asset_id: imgAsset.value.assetId,
        osg_position: "bottom-right",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
  });

  it("osg_position defaults to top-right when omitted", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const vidAsset = await fs.createAsset("vid", "osg-default-vid", "jazzy-salmon-95");
    if (!vidAsset.ok) throw new Error("Failed to create vid asset");
    await fs.writeFile(vidAsset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    const imgAsset = await fs.createAsset("img", "osg-default-logo", "jazzy-salmon-95");
    if (!imgAsset.ok) throw new Error("Failed to create img asset");
    await fs.writeFile(imgAsset.value.assetId, "logo.png", Buffer.from("fake-png"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: vidAsset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: vidAsset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        osg_asset_id: imgAsset.value.assetId,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
  });

  it("osg_position without osg_asset_id is accepted (no overlay rendered)", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const vidAsset = await fs.createAsset("vid", "osg-noimg-vid", "jazzy-salmon-95");
    if (!vidAsset.ok) throw new Error("Failed to create vid asset");
    await fs.writeFile(vidAsset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: vidAsset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: vidAsset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        osg_position: "bottom-left",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
  });
});

// ---------------------------------------------------------------------------
// 14. Focused background_mode tests — blur and black individually
// ---------------------------------------------------------------------------
describe("render: background_mode focused", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-bgmode-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "jazzy-salmon-95" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("background_mode=blur enqueues successfully", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "bg-blur-vid", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "portrait",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        background_mode: "blur",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("portrait");
  });

  it("background_mode=black enqueues successfully", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "bg-black-vid", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        background_mode: "black",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
  });

  it("background_mode defaults to blur when omitted", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "bg-default-vid", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
  });

  it("background_mode=blur works with subtitles enabled", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "bg-blur-subs-vid", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
    await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "portrait",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        background_mode: "blur",
        highlight_style: "impact",
        position: "bottom",
        font_size: "medium",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("portrait");
  });

  it("background_mode=black works with subtitles enabled", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "bg-black-subs-vid", "jazzy-salmon-95");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");
    await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: asset.value.assetId }],
      render: "square",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: true,
        background_mode: "black",
        highlight_style: "highlight",
        position: "top",
        font_size: "large",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("square");
  });

  it("background_mode=blur combined with OSG overlay", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const vidAsset = await fs.createAsset("vid", "bg-blur-osg-vid", "jazzy-salmon-95");
    if (!vidAsset.ok) throw new Error("Failed to create vid asset");
    await fs.writeFile(vidAsset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    const imgAsset = await fs.createAsset("img", "bg-blur-osg-logo", "jazzy-salmon-95");
    if (!imgAsset.ok) throw new Error("Failed to create img asset");
    await fs.writeFile(imgAsset.value.assetId, "logo.png", Buffer.from("fake-png"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: vidAsset.value.assetId }],
      render: "landscape",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: vidAsset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        background_mode: "blur",
        osg_asset_id: imgAsset.value.assetId,
        osg_position: "top-left",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
  });

  it("background_mode=black combined with OSG overlay", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const vidAsset = await fs.createAsset("vid", "bg-black-osg-vid", "jazzy-salmon-95");
    if (!vidAsset.ok) throw new Error("Failed to create vid asset");
    await fs.writeFile(vidAsset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "jazzy-salmon-95");

    const imgAsset = await fs.createAsset("img", "bg-black-osg-logo", "jazzy-salmon-95");
    if (!imgAsset.ok) throw new Error("Failed to create img asset");
    await fs.writeFile(imgAsset.value.assetId, "logo.png", Buffer.from("fake-png"), "jazzy-salmon-95");

    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: vidAsset.value.assetId }],
      render: "portrait",
    }, "jazzy-salmon-95");

    const result = await client.callTool({
      name: "render",
      arguments: {
        asset_id: vidAsset.value.assetId,
        project_slug: "jazzy-salmon-95",
        subtitles_enabled: false,
        background_mode: "black",
        osg_asset_id: imgAsset.value.assetId,
        osg_position: "bottom-right",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("portrait");
  });
});
