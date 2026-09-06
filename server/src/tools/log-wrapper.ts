import type { Engine } from "videobook-engine";
import { registerDiagnosticName } from "../diagnostics.js";
import { logger } from "../logger.js";
import type { ToolDef } from "./tool-def.js";

export function withLogging(def: ToolDef, _engine: Engine): ToolDef {
  registerDiagnosticName("tool", def.name);
  return {
    ...def,
    handler: async (args) => {
      const startedAt = performance.now();
      try {
        const result = await def.handler(args);
        logger.info("mcp", {
          tool: def.name,
          status: result.isError ? "error" : "ok",
          durationMs: Math.round(performance.now() - startedAt),
        });
        return result;
      } catch (error) {
        logger.info("mcp", {
          tool: def.name,
          status: "error",
          durationMs: Math.round(performance.now() - startedAt),
          error,
        });
        throw error;
      }
    },
  };
}
