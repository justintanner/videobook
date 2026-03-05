import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { createFsForTest } from "./fs.js";

export async function createTestClient(outputDir?: string): Promise<Client> {
  const fs = outputDir ? createFsForTest(outputDir) : undefined;
  const server = createServer(fs);
  const client = new Client({ name: "clipfirst-test", version: "0.0.1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
