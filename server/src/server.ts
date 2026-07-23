import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VideobookFs } from "videobook-engine";
import { registerAllTools } from "./tools/index.js";
import { fs as defaultFs } from "./fs.js";

export function createServer(fs?: VideobookFs): McpServer {
  const server = new McpServer({
    name: "videobook",
    version: "0.1.0",
  });

  registerAllTools(server, fs ?? defaultFs);

  return server;
}
