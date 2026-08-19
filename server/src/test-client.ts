import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { createHttpHandler, MCP_PROTOCOL_VERSION } from "./server.js";
import { closeEngineForTest, createEngineForTest } from "./engine.js";
import { registerAllJobHandlers } from "./jobs/index.js";
import { queue, setEngineRoot, stopBookQueue } from "./queue.js";
import { writeTimeline } from "./timeline-helpers.js";

function attachBookAliasShim(
  client: Client,
  currentEngine: () => Engine,
): Set<string> {
  const callTool = client.callTool.bind(client);
  const bookAliases = new Set<string>();
  client.callTool = async (params, options) => {
    const engine = currentEngine();
    if (params.name === "create_project") {
      const alias = params.arguments?.book_id;
      if (typeof alias !== "string") {
        return {
          isError: true,
          content: [{ type: "text", text: "book_id is required" }],
        };
      }
      bookAliases.add(alias);
      const book = engine.book.get();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            bookId: book.bookId,
            book_id: book.bookId,
            isDefault: true,
            name: alias,
          }),
        }],
      };
    }
    const bookId = params.arguments?.book_id;
    if (typeof bookId === "string" && bookAliases.has(bookId)) {
      return callTool({
        ...params,
        arguments: {
          ...params.arguments,
          book_id: engine.book.get().bookId,
        },
      }, options);
    }
    return callTool(params, options);
  };
  return bookAliases;
}

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
  if (fs) attachBookAliasShim(client, () => fs);
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

export interface ReusableTestClient {
  client: Client;
  root: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createReusableTestClient(
  parentDir: string,
): Promise<ReusableTestClient> {
  const root = join(parentDir, randomUUID());
  await mkdir(root, { recursive: true });
  const engine = createEngineForTest(root);
  await setEngineRoot(root, engine);
  registerAllJobHandlers(engine);
  const handler = createHttpHandler(() => engine);
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
  const bookAliases = attachBookAliasShim(client, () => engine);
  let closed = false;

  return {
    client,
    get root() {
      return root;
    },
    async reset() {
      bookAliases.clear();
      await stopBookQueue(engine.book.get().bookId);
      for (const artifact of [...engine.artifacts.list()]) {
        await engine.artifacts.delete(artifact.artifactId).catch(() => undefined);
      }
      for (const notebook of engine.notebooks.list()) {
        const read = engine.notebooks.read(notebook.id);
        if (!read.ok) continue;
        await engine.notebooks.write({
          ...read.value,
          cells: [],
          edges: [],
          execution: {},
          notebookRunPlans: [],
          generationPlans: [],
        });
      }
      await writeTimeline(engine, { render: "landscape", slots: [], audio: [] });
      await setEngineRoot(root, engine);
      registerAllJobHandlers(engine);
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
      await handler.close();
      await queue.stop();
      closeEngineForTest(root, engine);
    },
  };
}
