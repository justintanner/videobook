import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildDownloadVideoArguments } from "./url-target.js";

const LOCAL_MCP_URL = "http://127.0.0.1:3001/mcp";
const MCP_PROTOCOL_VERSION = "2026-07-28";

type QueueDownloadResult = {
  assetId: string;
  jobId: string;
  status: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readTextResult(result: unknown): string {
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

function parseJsonRecord(text: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new Error(`${label} returned invalid JSON.`);
  return parsed;
}

function parseDefaultProjectSlug(text: string): string {
  const parsed = parseJsonRecord(text, "get_default_project");
  const metadata = parsed.metadata;
  if (!isRecord(metadata) || typeof metadata.slug !== "string" || !metadata.slug) {
    throw new Error("Default project response did not include a project slug.");
  }
  return metadata.slug;
}

function parseDownloadResult(text: string): QueueDownloadResult {
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

export async function queueVideocityDownload(url: string): Promise<QueueDownloadResult> {
  const client = new Client(
    { name: "videocity-chrome-extension", version: "0.1.0" },
    {
      capabilities: {},
      supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(LOCAL_MCP_URL));

  await client.connect(transport);
  try {
    const projectResult = await client.callTool({
      name: "get_default_project",
      arguments: {},
    });
    const bookId = parseDefaultProjectSlug(readTextResult(projectResult));

    const downloadResult = await client.callTool({
      name: "download_video",
      arguments: buildDownloadVideoArguments(url, bookId),
    });
    return parseDownloadResult(readTextResult(downloadResult));
  } finally {
    await client.close();
  }
}
