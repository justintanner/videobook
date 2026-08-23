import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client'

const MCP_PROTOCOL_VERSION = '2026-07-28'
const APPLY_WATERMARK_TIMEOUT_MS = 21 * 60_000

export function mcpToolRequestTimeout(tool: string): number | undefined {
  return tool === 'apply_watermark' ? APPLY_WATERMARK_TIMEOUT_MS : undefined
}

export async function connectMcpClient(
  url: string,
  clientName: string,
): Promise<Client> {
  const client = new Client(
    { name: clientName, version: '0.1.0' },
    {
      capabilities: {},
      supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  )
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
    return client
  } catch (error) {
    await client.close()
    throw error
  }
}

export function callMcpTool(
  client: Client,
  tool: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const timeout = mcpToolRequestTimeout(tool)
  return client.callTool(
    { name: tool, arguments: args },
    timeout === undefined ? undefined : { timeout },
  )
}
