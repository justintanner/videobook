import { setTimeout as delay } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import { z } from "zod";
import type { RunFlags } from "./args.js";
import { onePasswordWarnings } from "./key-report.js";
import { gcLibraryCatalogs } from "../catalog-gc.js";
import { bookManager, scopedEngine } from "../engine.js";
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
const JOB_POLL_MS = 1_000;
const FINISHED_JOB_STATES: ReadonlySet<string> = new Set(["done", "failed", "aborted"]);
const SETTLED_STATUSES: ReadonlySet<string> = new Set(["completed", "done"]);

type JobReference = { job_ids: number[] } | { job_keys: string[] };

interface JobSnapshot {
  state: string;
  error: string | null;
}

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

function jobReference(first: Record<string, unknown> | null): JobReference | null {
  const value = first?.job_id;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return { job_ids: [value] };
  if (typeof value === "string" && value !== "") return { job_keys: [value] };
  return null;
}

function parseSnapshot(result: CallToolResult): JobSnapshot | null {
  if (result.isError) return null;
  const rows = JSON.parse(textOf(result)[0] ?? "[]") as unknown;
  const job = Array.isArray(rows) ? rows[0] as { state?: unknown; error?: { message?: unknown } | null } | undefined : undefined;
  if (!job || typeof job.state !== "string") return null;
  return { state: job.state, error: typeof job.error?.message === "string" ? job.error.message : null };
}

async function jobSnapshot(client: Client, bookId: string, reference: JobReference): Promise<JobSnapshot | null> {
  const result = await client.callTool({ name: "list_jobs", arguments: { book_id: bookId, ...reference } }) as CallToolResult;
  return parseSnapshot(result);
}

function reportJob(label: string, job: JobSnapshot): number {
  if (job.state === "done") {
    process.stderr.write(`Job ${label} completed.\n`);
    return 0;
  }
  process.stderr.write(`Job ${label} ${job.state}${job.error ? `: ${job.error}` : ""}\n`);
  return 1;
}

async function waitForJob(client: Client, bookId: string, reference: JobReference, label: string, timeoutSeconds: number): Promise<number> {
  process.stderr.write(`Waiting for job ${label}...\n`);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let job = await jobSnapshot(client, bookId, reference);
  while (job && !FINISHED_JOB_STATES.has(job.state) && Date.now() < deadline) {
    await delay(JOB_POLL_MS);
    job = await jobSnapshot(client, bookId, reference);
  }
  if (!job) {
    process.stderr.write(`Job ${label} is not tracked by the server; check it with list_jobs.\n`);
    return 0;
  }
  if (FINISHED_JOB_STATES.has(job.state)) return reportJob(label, job);
  process.stderr.write(`Job ${label} did not finish within ${timeoutSeconds} s.\n`);
  return 1;
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
  const reference = jobReference(first);
  const assetId = stringField(first, "asset_id");
  const bookId = typeof args.book_id === "string" ? args.book_id : null;
  const status = stringField(first, "status");
  if (!reference || (status && SETTLED_STATUSES.has(status))) return 0;
  if (!flags.wait && !session.temporary) return 0;
  if (assetId && bookId) return waitForAsset(session.client, bookId, assetId, flags.timeoutSeconds);
  if (!bookId) {
    process.stderr.write(`Job ${String(first?.job_id)} was queued; pass book_id to wait for it.\n`);
    return 0;
  }
  return waitForJob(session.client, bookId, reference, String(first?.job_id), flags.timeoutSeconds);
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
