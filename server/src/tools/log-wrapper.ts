import type { VideocityFs } from "vc-engine";
import { actionNameForTool, isLoggedToolActivity } from "./activity-policy.js";
import type { ToolDef } from "./tool-def.js";

function withLogging(def: ToolDef, fs: VideocityFs): ToolDef {
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

      const slug = args.project_slug as string | undefined;
      if (slug && isLoggedToolActivity(def.name, args, result)) {
        const actionName = actionNameForTool(def.name);
        const logPayload: Record<string, unknown> = result.isError
          ? { ...args, _error: result.content[0]?.text ?? "unknown error" }
          : args;
        fs.logAction(actionName, logPayload, slug).catch((e) => {
          console.warn(`[mcp] action log failed for ${actionName}:`, e);
        });
      }

      return result;
    },
  };
}

export { withLogging };
