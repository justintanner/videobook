import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { durationForDialog } from "../plan-screenshot-dialog.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ScreenshotDialogPlanSidecar } from "../plan-types.js";

type TextContent = Array<{ type: string; text: string }>;

describe("plan_screenshot_dialog tools", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-plan-screenshot-dialog-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("derives bounded scene durations from dialog length", () => {
    expect(durationForDialog("Hi.")).toBe(4);
    expect(durationForDialog(Array.from({ length: 25 }, (_, i) => `w${i}`).join(" "))).toBe(10);
    expect(durationForDialog(Array.from({ length: 100 }, (_, i) => `w${i}`).join(" "))).toBe(15);
  });

  it("rejects mismatched screenshot and dialog counts before enqueueing", async () => {
    const result = await client.callTool({
      name: "plan_screenshot_dialog",
      arguments: {
        project_slug: "test-proj",
        screenshot_asset_ids: ["img-a", "img-b"],
        dialog_blocks: ["Only one block"],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Expected 2 dialog block");
  });

  it("persists a scene video on a screenshots + dialog plan", async () => {
    const planDir = join(tempDir, "test-proj", "plan");
    await mkdir(planDir, { recursive: true });
    const sidecar: ScreenshotDialogPlanSidecar = {
      formula: "screenshot_dialog",
      scenes: [{
        image_asset_id: "img-shot",
        dialog: "Hello there.",
        visual: "A close-up speaker turns toward camera and delivers the line.",
        duration_s: 4,
        video: null,
      }],
      screenshot_asset_ids: ["img-shot"],
      total_duration_s: 4,
      model: "gpt-test-model",
    };
    await writeFile(join(planDir, ".plan.json"), JSON.stringify(sidecar, null, 2));
    await mkdir(join(tempDir, "test-proj", "vid-rendered"), { recursive: true });

    const result = await client.callTool({
      name: "replace_plan_screenshot_dialog_scene_video",
      arguments: {
        project_slug: "test-proj",
        scene_index: 0,
        asset_id: "vid-rendered",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text) as {
      sidecar: ScreenshotDialogPlanSidecar;
    };
    expect(parsed.sidecar.scenes[0].video).toBe("vid-rendered");
  });
});
