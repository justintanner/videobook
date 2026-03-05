import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHelloTool } from "./hello.js";

export function registerAllTools(server: McpServer): void {
  registerHelloTool(server);
}
