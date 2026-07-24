import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Engine } from "videobook-engine";
import type { BookManager } from "./book-manager.js";
import { registerAllTools } from "./tools/index.js";
import { bookManager, fs as defaultFs } from "./fs.js";

export function createServer(
  fs: Engine = defaultFs,
  books: BookManager = bookManager,
): McpServer {
  const server = new McpServer({
    name: "videobook",
    version: "0.1.0",
  });

  registerAllTools(server, fs, books);

  return server;
}
