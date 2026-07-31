import type { Engine } from "videobook-engine";
import type { ToolDef, ToolResult } from "./tool-def.js";

function firstErrorText(result: ToolResult): string | null {
  if (!result.isError) return null;
  const text = result.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function withLogging(def: ToolDef, _engine: Engine): ToolDef {
  return {
    ...def,
    handler: async (args) => {
      const startedAt = performance.now();
      const result = await def.handler(args);
      const elapsed = Math.round(performance.now() - startedAt);
      const status = result.isError ? "error" : "ok";
      const detail = firstErrorText(result);
      console.log(
        detail
          ? `[mcp] ${def.name} ${status} ${elapsed}ms ${detail}`
          : `[mcp] ${def.name} ${status} ${elapsed}ms`,
      );
      return result;
    },
  };
}
