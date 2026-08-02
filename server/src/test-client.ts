import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHttpHandler, MCP_PROTOCOL_VERSION } from "./server.js";
import { closeEngineForTest, createEngineForTest } from "./fs.js";
import { registerAllJobHandlers } from "./jobs/index.js";
import { queue, setEngineRoot } from "./queue.js";

export async function createTestClient(projectsDir?: string): Promise<Client> {
  const fs = projectsDir ? createEngineForTest(projectsDir) : undefined;
  if (projectsDir) await setEngineRoot(projectsDir, fs);
  registerAllJobHandlers(fs!);
  const handler = createHttpHandler(fs);
  const client = new Client(
    { name: "videocity-test", version: "0.0.1" },
    {
      capabilities: {},
      supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://test.local/mcp"),
    {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    },
  );
  await client.connect(transport);
  const close = client.close.bind(client);
  let closed = false;
  client.close = async () => {
    if (closed) return;
    closed = true;
    await close();
    await handler.close();
    await queue.stop();
    if (projectsDir && fs) closeEngineForTest(projectsDir, fs);
  };
  return client;
}
