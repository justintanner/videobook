import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import { FFMPEG } from "../ffmpeg.js";
import { queue } from "../queue.js";
import { createTestClient } from "../test-client.js";

const execFileAsync = promisify(execFile);

type TextContent = Array<{ type: string; text: string }>;

function parse(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as TextContent)[0].text);
}

describe("timewarp_video tool", () => {
  let client: Client;
  let tempDir: string;
  let assetId: string;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-timewarp-tool-"));
    const sourcePath = join(tempDir, "source.mp4");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      sourcePath,
    ]);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "timewarp-tool" },
    });
    const upload = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "timewarp-tool",
        filename: "original.mp4",
        data: (await readFile(sourcePath)).toString("base64"),
      },
    });
    assetId = String(parse(upload).assetId);
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("is registered with the MCP server", async () => {
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "timewarp_video")).toBe(true);
  });

  it.each([
    { start_seconds: -1, end_seconds: 1, stretch_factor: 1.5, message: "range" },
    { start_seconds: 1, end_seconds: 1, stretch_factor: 1.5, message: "range" },
    { start_seconds: 0, end_seconds: 2, stretch_factor: 1.5, message: "full clip" },
    { start_seconds: 0, end_seconds: 1, stretch_factor: 1, message: "no-op" },
    { start_seconds: 0, end_seconds: 1, stretch_factor: 5, message: "between" },
  ])("returns a structured error for invalid request %#", async (request) => {
    const result = await client.callTool({
      name: "timewarp_video",
      arguments: {
        asset_id: assetId,
        book_id: "timewarp-tool",
        start_seconds: request.start_seconds,
        end_seconds: request.end_seconds,
        stretch_factor: request.stretch_factor,
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain(request.message);
  });

  it("returns a structured error for a missing asset", async () => {
    const result = await client.callTool({
      name: "timewarp_video",
      arguments: {
        asset_id: "vid-missing",
        book_id: "timewarp-tool",
        start_seconds: 0,
        end_seconds: 1,
        stretch_factor: 1.5,
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns timing details when it enqueues a valid job", async () => {
    const result = await client.callTool({
      name: "timewarp_video",
      arguments: {
        asset_id: assetId,
        book_id: "timewarp-tool",
        start_seconds: 0,
        end_seconds: 0.5,
        stretch_factor: 1.5,
      },
    });

    expect(result.isError).toBeFalsy();
    const response = parse(result);
    expect(response.asset_id).toBe(assetId);
    expect(response.job_id).toMatch(/^timewarp-/);
    expect(response.status).toBe("enqueued");
    expect(response.source_duration).toBeCloseTo(2, 1);
    expect(response.selected_output_duration).toBeCloseTo(0.75, 2);
    expect(response.outside_stretch_factor).toBeCloseTo(1.25 / 1.5, 2);
  });
});
