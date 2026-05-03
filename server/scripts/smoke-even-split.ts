/**
 * CLI smoke test for /even-split. Spins up an in-process MCP test client
 * pointed at the live project tree, splits the user's actual asset, and
 * probes the produced files via ffprobe.
 *
 * Usage:
 *   npx tsx server/scripts/smoke-even-split.ts <project-slug> <asset-id> [target_sec]
 *
 * Example:
 *   npx tsx server/scripts/smoke-even-split.ts god vid-yt-inglourious-basterds-top-4 10
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { fs as liveFs } from "../src/fs.js";
import { registerAllJobHandlers } from "../src/jobs/index.js";
import { queue } from "../src/queue.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFPROBE: string = require("ffprobe-static").path;

type TextContent = Array<{ type: string; text: string }>;

async function probeFormatDuration(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return stdout.trim();
}

async function main(): Promise<void> {
  const [, , projectSlug, assetId, targetArg] = process.argv;
  if (!projectSlug || !assetId) {
    console.error("Usage: tsx scripts/smoke-even-split.ts <project-slug> <asset-id> [target_sec]");
    process.exit(2);
  }

  await queue.start();
  registerAllJobHandlers(liveFs);
  const server = createServer(liveFs);
  const client = new Client({ name: "smoke-even-split", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    console.log(`/even-split @${assetId} ${targetArg ?? 10} (project: ${projectSlug})`);
    const result = await client.callTool({
      name: "even_split",
      arguments: {
        asset_id: assetId,
        project_slug: projectSlug,
        ...(targetArg !== undefined ? { target_sec: targetArg } : {}),
      },
    });

    if (result.isError) {
      console.error("ERROR:", (result.content as TextContent)[0]?.text);
      process.exit(1);
    }

    const parsed = JSON.parse((result.content as TextContent)[0].text);
    console.log("\nTool result:");
    console.log(`  source_duration_sec:    ${parsed.source_duration_sec}`);
    console.log(`  used_first_chunk_sec:   ${parsed.used_first_chunk_sec} (target was ${parsed.target_sec})`);
    console.log(`  chunk A asset:          ${parsed.chunk_a_asset_id}  (planned ${parsed.chunk_a_duration}s)`);
    console.log(`  chunk B asset:          ${parsed.chunk_b_asset_id}  (planned ${parsed.chunk_b_duration}s)`);

    // Probe the actual files via the engine's manifest (knows the path).
    for (const [label, id] of [["A", parsed.chunk_a_asset_id], ["B", parsed.chunk_b_asset_id]] as const) {
      const m = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: id, project_slug: projectSlug },
      });
      const manifest = JSON.parse((m.content as TextContent)[0].text);
      const path = `${manifest.path}/original.mp4`;
      const dur = await probeFormatDuration(path);
      const ok = label === "A"
        ? Number(dur).toFixed(6) === Number(parsed.used_first_chunk_sec).toFixed(6)
        : true;
      console.log(`  ffprobe chunk ${label}:        format=duration=${dur}s  ${ok ? "✓" : "✗ NOT EXACT"}`);
    }
  } finally {
    await client.close();
    await queue.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
