import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { closeEngineForTest, createEngineForTest } from "./fs.js";
import { registerAllJobHandlers } from "./jobs/index.js";
import { queue, setEngineRoot } from "./queue.js";

export async function createTestClient(projectsDir?: string): Promise<Client> {
  const fs = projectsDir ? createEngineForTest(projectsDir) : undefined;
  if (projectsDir) await setEngineRoot(projectsDir, fs);
  registerAllJobHandlers(fs!);
  const server = createServer(fs);
  const client = new Client(
    { name: "videocity-test", version: "0.0.1" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const close = client.close.bind(client);
  let closed = false;
  client.close = async () => {
    if (closed) return;
    closed = true;
    await close();
    await queue.stop();
    if (projectsDir && fs) closeEngineForTest(projectsDir, fs);
  };
  return client;
}
