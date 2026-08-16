import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildDownloadVideoArguments } from "./url-target.js";

const LOCAL_MCP_URL = "http://127.0.0.1:3001/mcp";
const MCP_PROTOCOL_VERSION = "2026-07-28";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type QueueDownloadResult = {
  assetId: string;
  jobId: string;
  status: string;
};

export type McpToolRequest = {
  name: string;
  arguments: Record<string, unknown>;
};

export type VideobookMcpSession = {
  connect(): Promise<void>;
  callTool(request: McpToolRequest): Promise<unknown>;
  close(): Promise<void>;
};

type VideobookMcpSessionFactory = () => VideobookMcpSession;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readTextResult(result: unknown): string {
  if (!isRecord(result)) throw new Error("MCP returned an invalid response.");

  const content = result.content;
  if (!Array.isArray(content)) throw new Error("MCP response did not include text content.");

  const textContent = content.find((item): item is { type: "text"; text: string } => (
    isRecord(item) && item.type === "text" && typeof item.text === "string"
  ));

  if (!textContent) throw new Error("MCP response did not include text content.");
  if (result.isError === true) throw new Error(textContent.text);

  return textContent.text;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function parseJsonRecord(text: string, label: string): Record<string, unknown> {
  const parsed = parseJson(text, label);
  if (!isRecord(parsed)) throw new Error(`${label} returned invalid JSON.`);
  return parsed;
}

export function parseNewestBookId(text: string): string {
  const parsed = parseJson(text, "list_books");
  if (!Array.isArray(parsed)) throw new Error("list_books returned an invalid book list.");
  if (parsed.length === 0) throw new Error("No Videobook books are available.");

  const newestBook = parsed[0];
  if (
    !isRecord(newestBook) ||
    typeof newestBook.bookId !== "string" ||
    !UUID_PATTERN.test(newestBook.bookId)
  ) {
    throw new Error("list_books did not return a UUID bookId for the newest book.");
  }
  return newestBook.bookId;
}

export function parseDownloadResult(text: string): QueueDownloadResult {
  const parsed = parseJsonRecord(text, "download_video");
  if (
    typeof parsed.assetId !== "string" ||
    typeof parsed.job_id !== "string" ||
    typeof parsed.status !== "string"
  ) {
    throw new Error("Download response did not include an asset and job id.");
  }
  return {
    assetId: parsed.assetId,
    jobId: parsed.job_id,
    status: parsed.status,
  };
}

function createLocalMcpSession(): VideobookMcpSession {
  const client = new Client(
    { name: "videobook-chrome-extension", version: "0.1.0" },
    {
      capabilities: {},
      supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(LOCAL_MCP_URL));

  return {
    connect: async () => {
      await client.connect(transport);
    },
    callTool: async (request) => await client.callTool(request),
    close: async () => {
      await client.close();
    },
  };
}

export async function queueVideobookDownload(
  url: string,
  createSession: VideobookMcpSessionFactory = createLocalMcpSession,
): Promise<QueueDownloadResult> {
  const session = createSession();
  try {
    await session.connect();
    const booksResult = await session.callTool({
      name: "list_books",
      arguments: { sort: "newest" },
    });
    const bookId = parseNewestBookId(readTextResult(booksResult));

    const downloadResult = await session.callTool({
      name: "download_video",
      arguments: buildDownloadVideoArguments(url, bookId),
    });
    return parseDownloadResult(readTextResult(downloadResult));
  } finally {
    await session.close().catch(() => undefined);
  }
}
