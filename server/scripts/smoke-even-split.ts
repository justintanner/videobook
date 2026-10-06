/**
 * CLI smoke test for /even-split. Spins up an in-process MCP test client
 * pointed at the live project tree, splits the user's actual asset, and
 * probes the produced files via ffprobe.
 *
 * Usage:
 *   npx tsx server/scripts/smoke-even-split.ts <project-slug> <asset-id> [target_secs...]
 *
 * Example:
 *   npx tsx server/scripts/smoke-even-split.ts god vid-yt-inglourious-basterds-top-4 10 15
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHttpHandler, MCP_PROTOCOL_VERSION } from "../src/server.js";
import { scopedEngine as liveFs } from "../src/engine.js";
import { registerAllJobHandlers } from "../src/jobs/index.js";
import { queue } from "../src/queue.js";
import { FFPROBE } from "../src/ffprobe-binary.js";

const execFileAsync = promisify(execFile);

type TextContent = Array<{ type: string; text: string }>;
type ParsedChunk = { asset_id: string; duration: number; exact: boolean };

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
  const [, , bookId, assetId, ...targetArgs] = process.argv;
  if (!bookId || !assetId) {
    console.error("Usage: tsx scripts/smoke-even-split.ts <project-slug> <asset-id> [target_secs...]");
    process.exit(2);
  }

  await queue.start();
  registerAllJobHandlers(liveFs);
  const handler = createHttpHandler(liveFs);
  const client = new Client(
    { name: "smoke-even-split", version: "0.0.1" },
    {
      capabilities: {},
      supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://test.local/mcp"),
    { fetch: (url, init) => handler.fetch(new Request(url, init)) },
  );
  await client.connect(transport);
  try {
    const targetsLabel = targetArgs.length > 0 ? targetArgs.join(" ") : "10 (default)";
    console.log(`/even-split @${assetId} ${targetsLabel} (project: ${bookId})`);
    const result = await client.callTool({
      name: "even_split",
      arguments: {
        asset_id: assetId,
        book_id: bookId,
        ...(targetArgs.length > 0 ? { target_secs: targetArgs } : {}),
      },
    });

    if (result.isError) {
      console.error("ERROR:", (result.content as TextContent)[0]?.text);
      process.exit(1);
    }

    const parsed = JSON.parse((result.content as TextContent)[0].text);
    console.log("\nTool result:");
    console.log(`  source_duration_sec:    ${parsed.source_duration_sec}`);
    console.log(`  target_secs:            [${parsed.target_secs.join(", ")}]`);
    console.log(`  used_target_secs:       [${parsed.used_target_secs.join(", ")}]`);
    console.log(`  has_leftover:           ${parsed.has_leftover}`);
    for (let i = 0; i < parsed.chunks.length; i++) {
      const c: ParsedChunk = parsed.chunks[i];
      const tag = c.exact ? "targeted" : "leftover";
      console.log(`  chunk ${i + 1} (${tag}):    ${c.asset_id}  (planned ${c.duration}s)`);
    }

    // Probe the actual files via the engine's manifest (knows the path).
    for (let i = 0; i < parsed.chunks.length; i++) {
      const c: ParsedChunk = parsed.chunks[i];
      const m = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: c.asset_id, book_id: bookId },
      });
      const manifest = JSON.parse((m.content as TextContent)[0].text);
      const path = `${manifest.path}/original.mp4`;
      const dur = await probeFormatDuration(path);
      const ok = c.exact
        ? Number(dur).toFixed(6) === Number(c.duration).toFixed(6)
        : true;
      console.log(`  ffprobe chunk ${i + 1}:        format=duration=${dur}s  ${ok ? "✓" : "✗ NOT EXACT"}`);
    }
  } finally {
    await client.close();
    await handler.close();
    await queue.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
