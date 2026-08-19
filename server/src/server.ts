import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type { Engine } from "videobook-engine";
import type { BookManager } from "./book-manager.js";
import { registerAllTools } from "./tools/index.js";
import { bookManager, scopedEngine as defaultFs } from "./engine.js";

export const MCP_PROTOCOL_VERSION = "2026-07-28";

function createServer(
  engine: Engine = defaultFs,
  books: BookManager = bookManager,
): McpServer {
  const server = new McpServer({
    name: "videobook",
    version: "0.1.0",
  }, {
    supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
  });

  registerAllTools(server, engine, books);

  return server;
}

export function createHttpHandler(
  engine: Engine | (() => Engine) = defaultFs,
  books: BookManager = bookManager,
): McpHttpHandler {
  const resolveEngine = typeof engine === "function" ? engine : () => engine;
  return createMcpHandler(() => createServer(resolveEngine(), books), {
    legacy: "reject",
  });
}
