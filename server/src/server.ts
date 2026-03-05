import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tools/index.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "clipfirst",
    version: "0.0.1",
  });

  registerAllTools(server);

  return server;
}
