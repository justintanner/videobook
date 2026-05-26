import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "vc-engine";
import { registerAllTools } from "./tools/index.js";
import { fs as defaultFs } from "./fs.js";

export function createServer(fs?: ClipfirstFs): McpServer {
  const server = new McpServer({
    name: "clipfirst",
    version: "0.0.1",
  });

  registerAllTools(server, fs ?? defaultFs);

  return server;
}
