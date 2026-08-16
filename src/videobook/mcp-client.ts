import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client'

const MCP_PROTOCOL_VERSION = '2026-07-28'

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
  return client.callTool({ name: tool, arguments: args })
}
