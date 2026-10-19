import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import { z } from "zod";
import type { RunFlags } from "./args.js";
import { onePasswordWarnings } from "./key-report.js";
import { gcLibraryCatalogs } from "../catalog-gc.js";
import { bookManager, scopedEngine } from "../engine.js";
import { waitForJob } from "../queue.js";
import { MCP_PROTOCOL_VERSION, SERVER_VERSION } from "../server.js";
import { inspectServerOwner, type ServerOwner } from "../server-lock.js";
import { startServer, type RunningServer } from "../serve.js";
import { getAllToolDefs } from "../tools/index.js";

interface OwnerSession {
  client: Client;
  temporary: boolean;
  close(): Promise<void>;
}

interface ToolListing {
  name: string;
  description?: string;
  required: string[];
  optional: string[];
}

const REQUEST_GRACE_MS = 60_000;

function newClient(): Client {
  return new Client({ name: "videobook-cli", version: SERVER_VERSION }, {
    capabilities: {},
    supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
    versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
  });
}

async function connect(mcpUrl: string): Promise<Client> {
  const client = newClient();
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  return client;
}

function refuseUnresponsive(owner: ServerOwner): void {
  if (owner.kind !== "unresponsive") return;
  throw new Error(`videobook (pid ${owner.record.pid}) holds ${bookManager.rootDir} but is not responding. Stop it first.`);
}

async function temporaryOwner(): Promise<OwnerSession> {
  const running: RunningServer = await startServer({ port: 0, ui: false });
  for (const warning of onePasswordWarnings()) process.stderr.write(`videobook: ${warning}\n`);
  await running.ready;
  const client = await connect(running.mcpUrl);
  return {
    client,
    temporary: true,
    async close() {
      await client.close();
      await running.close();
    },
  };
}

async function openOwnerSession(): Promise<OwnerSession> {
  const owner = await inspectServerOwner(bookManager.rootDir);
  refuseUnresponsive(owner);
  if (owner.kind !== "running") return temporaryOwner();
  const client = await connect(`${owner.record.url}/mcp`);
  return { client, temporary: false, close: () => client.close() };
}

function textOf(result: CallToolResult): string[] {
  return result.content.flatMap((item) => item.type === "text" ? [item.text] : [JSON.stringify(item)]);
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

async function waitInProcess(jobId: string, timeoutSeconds: number): Promise<number> {
  process.stderr.write(`Waiting for job ${jobId}...\n`);
  try {
    await waitForJob(jobId, timeoutSeconds * 1000);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  process.stderr.write(`Job ${jobId} completed.\n`);
  return 0;
}

async function waitForAsset(client: Client, bookId: string, assetId: string, timeoutSeconds: number): Promise<number> {
  process.stderr.write(`Waiting for asset ${assetId}...\n`);
  const result = await client.callTool(
    { name: "wait_for_asset_ready", arguments: { book_id: bookId, asset_id: assetId, timeout_seconds: timeoutSeconds } },
    { timeout: timeoutSeconds * 1000 + REQUEST_GRACE_MS },
  ) as CallToolResult;
  for (const line of textOf(result)) process.stdout.write(`${line}\n`);
  return result.isError ? 1 : 0;
}

async function waitForOutcome(
  session: OwnerSession,
  flags: RunFlags,
  args: Record<string, unknown>,
  first: Record<string, unknown> | null,
): Promise<number> {
  const jobId = stringField(first, "job_id");
  const assetId = stringField(first, "asset_id");
  const bookId = typeof args.book_id === "string" ? args.book_id : null;
  if (session.temporary && jobId) return waitInProcess(jobId, flags.timeoutSeconds);
  if (!flags.wait || !jobId) return 0;
  if (assetId && bookId) return waitForAsset(session.client, bookId, assetId, flags.timeoutSeconds);
  process.stderr.write(`Job ${jobId} is queued on the running server; follow it with list_jobs.\n`);
  return 0;
}

async function callOnce(
  session: OwnerSession,
  flags: RunFlags,
  tool: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | null> {
  try {
    return await session.client.callTool(
      { name: tool, arguments: args },
      { timeout: flags.timeoutSeconds * 1000 + REQUEST_GRACE_MS },
    ) as CallToolResult;
  } catch (error) {
    process.stderr.write(`videobook run: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
}

export async function runToolCommand(flags: RunFlags, tool: string, args: Record<string, unknown>): Promise<number> {
  const session = await openOwnerSession();
  try {
    const result = await callOnce(session, flags, tool, args);
    if (!result) return 1;
    const lines = textOf(result);
    const stream = result.isError ? process.stderr : process.stdout;
    for (const line of lines) stream.write(`${line}\n`);
    if (result.isError) return 1;
    return await waitForOutcome(session, flags, args, parseJsonObject(lines[0]));
  } finally {
    await session.close();
  }
}

function listingFromJsonSchema(tool: Tool): ToolListing {
  const properties = Object.keys(tool.inputSchema.properties ?? {});
  const required = new Set(tool.inputSchema.required ?? []);
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    required: properties.filter((key) => required.has(key)),
    optional: properties.filter((key) => !required.has(key)),
  };
}

function localListings(): ToolListing[] {
  return getAllToolDefs(scopedEngine, bookManager).map((def) => {
    const schema = z.object(def.schema).toJSONSchema() as { required?: string[] };
    const required = new Set(schema.required ?? []);
    const keys = Object.keys(def.schema);
    return {
      name: def.name,
      ...(def.description ? { description: def.description } : {}),
      required: keys.filter((key) => required.has(key)),
      optional: keys.filter((key) => !required.has(key)),
    };
  });
}

async function ownerListings(owner: ServerOwner): Promise<ToolListing[] | null> {
  if (owner.kind !== "running") return null;
  const client = await connect(`${owner.record.url}/mcp`);
  try {
    return (await client.listTools()).tools.map(listingFromJsonSchema);
  } finally {
    await client.close();
  }
}

function renderListing(listing: ToolListing): string {
  const params = [...listing.required.map((key) => `<${key}>`), ...listing.optional.map((key) => `[${key}]`)].join(" ");
  const head = params ? `${listing.name} ${params}` : listing.name;
  return listing.description ? `${head}\n    ${listing.description}` : head;
}

export async function runToolsCommand(): Promise<number> {
  const owner = await inspectServerOwner(bookManager.rootDir);
  refuseUnresponsive(owner);
  const listings = await ownerListings(owner) ?? localListings();
  for (const listing of listings) process.stdout.write(`${renderListing(listing)}\n`);
  return 0;
}

export async function runGcBooksCommand(): Promise<number> {
  const owner = await inspectServerOwner(bookManager.rootDir);
  if (owner.kind !== "none") {
    process.stderr.write(`videobook is running at ${owner.record.url} (pid ${owner.record.pid}); stop it before collecting catalog garbage.\n`);
    return 1;
  }
  try {
    const reports = await gcLibraryCatalogs(bookManager);
    process.stdout.write(`${JSON.stringify({ catalogs: reports }, null, 2)}\n`);
    return 0;
  } finally {
    await bookManager.close();
  }
}
