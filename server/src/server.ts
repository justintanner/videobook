import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type { Engine } from "videobook-engine";
import type { BookManager } from "./book-manager.js";
import { registerAllTools } from "./tools/index.js";
import { bookManager, fs as defaultFs } from "./fs.js";

export const MCP_PROTOCOL_VERSION = "2026-07-28";

function createServer(
  fs: Engine = defaultFs,
  books: BookManager = bookManager,
): McpServer {
  const server = new McpServer({
    name: "videobook",
    version: "0.1.0",
  }, {
    supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
  });

  registerAllTools(server, fs, books);

  return server;
}

export function createHttpHandler(
  fs: Engine = defaultFs,
  books: BookManager = bookManager,
): McpHttpHandler {
  return createMcpHandler(() => createServer(fs, books), {
    legacy: "reject",
  });
}
