import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerHelloTool(server: McpServer): void {
  server.tool(
    "hello_world",
    "A simple greeting tool to verify the MCP connection works",
    { name: z.string().describe("Name to greet") },
    async ({ name }) => ({
      content: [{ type: "text", text: `Hello, ${name}! Welcome to Clipfirst.` }],
    })
  );
}
