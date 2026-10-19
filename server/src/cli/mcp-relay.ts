import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import { McpServer, fromJsonSchema, type CallToolResult, type JsonSchemaType } from "@modelcontextprotocol/server";
import { MCP_PROTOCOL_VERSION, SERVER_VERSION } from "../server.js";

export interface UpstreamConnection {
  url: string;
  client: Client;
  tools: Tool[];
  close(): Promise<void>;
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

export async function connectUpstream(mcpUrl: string): Promise<UpstreamConnection> {
  const client = new Client({ name: "videobook-mcp-relay", version: SERVER_VERSION }, {
    capabilities: {},
    supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
    versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  return { url: mcpUrl, client, tools: await listAllTools(client), close: () => client.close() };
}

function unreachable(url: string, error: unknown): CallToolResult {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `The videobook server at ${url} did not answer (${reason}). Restart it or restart videobook mcp.` }],
  };
}

function registerRelayedTool(server: McpServer, upstream: UpstreamConnection, tool: Tool): void {
  server.registerTool(tool.name, {
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
  }, async (args: unknown) => {
    try {
      return await upstream.client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }) as CallToolResult;
    } catch (error) {
      return unreachable(upstream.url, error);
    }
  });
}

export function createRelayServer(upstream: UpstreamConnection, instructions: string): McpServer {
  const server = new McpServer({ name: "videobook", version: SERVER_VERSION }, { instructions });
  for (const tool of upstream.tools) registerRelayedTool(server, upstream, tool);
  return server;
}
