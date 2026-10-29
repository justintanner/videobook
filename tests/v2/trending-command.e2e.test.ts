import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { testBudget } from "../../server/src/test-budget.js";
import { callTool, startServer, stopServer, type StartedServer } from "./mcp-http-test-server.js";

describe("trending_research over HTTP", () => {
  let rootDir = "";
  let server: StartedServer | undefined;
  let client: Client;

  afterEach(async () => {
    await client?.close();
    await stopServer(server);
    server = undefined;
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("schedules Thailand from omitted arguments and reads that schedule back", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "trending-http-"));
    server = await startServer(rootDir);
    client = new Client({ name: "trending-http-e2e", version: "1" }, {
      capabilities: {},
      supportedProtocolVersions: ["2026-07-28"],
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    const scheduled = await callTool<{ schedule: Record<string, unknown> }>(client, "trending_research", { op: "schedule" });
    expect(scheduled.schedule).toMatchObject({
      platform: "tiktok",
      country: "TH",
      timezone: "Asia/Bangkok",
      cutoffLocalTime: "00:30",
      samplesPerDay: 4,
      topN: 10,
      window: "trending",
      excludePromoted: true,
      retentionDays: 30,
      sources: [{ id: "endless" }, { id: "tiktok-creative-center" }],
      downstream: { transcribe: false, translateTo: [], analyze: false },
      enabled: true,
    });
    const status = await callTool<{ schedules: Array<{ schedule: { country: string; enabled: boolean } }> }>(client, "trending_research", { op: "status" });
    expect(status.schedules).toHaveLength(1);
    expect(status.schedules[0]?.schedule.country).toBe("TH");
    await callTool(client, "trending_research", { op: "unschedule" });
    const disabled = await callTool<{ schedules: Array<{ schedule: { enabled: boolean } }> }>(client, "trending_research", { op: "status" });
    expect(disabled.schedules[0]?.schedule.enabled).toBe(false);
  }, testBudget(90_000));
});
