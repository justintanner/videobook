import { createKimiCoding } from "@apicity/kimicoding";
import { isPlaceholderApiKey } from "../api-key.js";
import type { ToolDef } from "./tool-def.js";

export function apiStatusDef(): ToolDef {
  return {
    name: "api_status",
    description: "Check if the KimiCoding API is reachable and the API key is valid",
    schema: {},
    handler: async () => {
      const apiKey = process.env.KIMI_CODING_API_KEY;
      if (!apiKey) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIMI_CODING_API_KEY environment variable is not set" }],
        };
      }
      if (isPlaceholderApiKey(apiKey)) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIMI_CODING_API_KEY is a placeholder; refusing to call the real API" }],
        };
      }

      try {
        const provider = createKimiCoding({ apiKey });
        await provider.post.coding.v1.messages({
          model: "k2p5",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        });
        return {
          content: [{ type: "text" as const, text: "200 OK" }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: message }],
        };
      }
    },
  };
}

