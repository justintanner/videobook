import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { kimicoding } from "@nakedapi/kimicoding";

export function registerApiStatusTool(server: McpServer): void {
  server.tool(
    "api_status",
    "Check if the KimiCoding API is reachable and the API key is valid",
    {},
    async () => {
      const apiKey = process.env.KIMI_CODING_API_KEY;
      if (!apiKey) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "KIMI_CODING_API_KEY environment variable is not set" }],
        };
      }

      try {
        const provider = kimicoding({ apiKey });
        await provider.chat({
          model: "k2p5",
          messages: [{ role: "user", content: "hi" }],
        });
        return {
          content: [{ type: "text" as const, text: "200 OK" }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text" as const, text: message }],
        };
      }
    }
  );
}
