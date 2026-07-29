import type { Engine } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";

export function withLogging(def: ToolDef, _engine: Engine): ToolDef {
  return {
    ...def,
    handler: async (args) => {
      const startedAt = performance.now();
      const result = await def.handler(args);
      console.log(`[mcp] ${def.name} ${result.isError ? "error" : "ok"} ${Math.round(performance.now() - startedAt)}ms`);
      return result;
    },
  };
}
