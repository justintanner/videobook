import type { ClipfirstFs } from "clipfirst-engine";
import type { ToolDef } from "./tool-def.js";

function withLogging(def: ToolDef, fs: ClipfirstFs): ToolDef {
  return {
    ...def,
    handler: async (args) => {
      const start = performance.now();
      const result = await def.handler(args);
      const ms = Math.round(performance.now() - start);

      const status = result.isError ? "error" : "ok";
      const suffix = result.isError
        ? ` ${result.content[0]?.text.slice(0, 80)}`
        : "";
      console.log(`[mcp] ${def.name} ${status} ${ms}ms${suffix}`);

      // Persist to project git log when project_slug is present
      const slug = args.project_slug as string | undefined;
      if (slug) {
        const actionName = `tool-${def.name.replace(/_/g, "-")}`;
        const logPayload: Record<string, unknown> = result.isError
          ? { ...args, _error: result.content[0]?.text ?? "unknown error" }
          : args;
        // Fire-and-forget — don't block tool response on git commit
        fs.logAction(actionName, logPayload, slug).catch((e) => {
          console.warn(`[mcp] action log failed for ${actionName}:`, e);
        });
      }

      return result;
    },
  };
}

export { withLogging };
