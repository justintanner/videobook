import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestClient } from "../test-client.js";

type TextContent = Array<{ type: string; text: string }>;

describe("service connection tools", () => {
  let client: Client;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-connect-service-"));
    client = await createTestClient(root);
  });

  afterEach(async () => {
    await client?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function status(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await client.callTool({ name: "service_status", arguments: args });
    expect(result.isError).toBeFalsy();
    return JSON.parse((result.content as TextContent)[0]!.text) as Record<string, unknown>;
  }

  it("reports X, Dropbox and iCloud status through one tool", async () => {
    expect(await status({ service: "x", refresh_account: true })).toMatchObject({ connected: false, has_credentials: false });
    expect(Object.keys(await status({ service: "dropbox" }))).toEqual(
      expect.arrayContaining(["connected", "pending", "has_credentials", "redirect_uri"]),
    );
    expect(Object.keys(await status({ service: "icloud" }))).toEqual(
      expect.arrayContaining(["available", "root", "shared", "role", "reason"]),
    );
  });

  it("explains a missing X app before starting an authorization", async () => {
    const result = await client.callTool({ name: "connect_service", arguments: { service: "x" } });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0]!.text).toMatch(/X_CLIENT_ID and X_CLIENT_SECRET must be set/u);
  });

  it("rejects services it cannot connect", async () => {
    const result = await client.callTool({ name: "connect_service", arguments: { service: "icloud" } });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0]!.text).toMatch(/Input validation error/u);
  });
});
