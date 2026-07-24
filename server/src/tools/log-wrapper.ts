import { randomUUID } from "node:crypto";

import type {
  BookActionPhase,
  BookActionScope,
  Engine,
} from "videobook-engine";
import { actionNameForTool, isBookToolActivity } from "./activity-policy.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const ARTIFACT_ID =
  /^@?(?:img|vid|prm|char|scn|aud|scr|nb)-[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function toolResultValue(result: ToolResult): unknown {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function collectArtifactIds(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string" && ARTIFACT_ID.test(value)) {
    found.add(value.replace(/^@/, ""));
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactIds(item, found);
    return found;
  }
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) collectArtifactIds(nested, found);
  }
  return found;
}

function boundedValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 32_000) return value;
  return {
    truncated: true,
    bytes: Buffer.byteLength(serialized),
  };
}

function actionScope(
  toolName: string,
  inputs: string[],
  outputs: string[],
): BookActionScope {
  if (toolName.includes("project")) return "project";
  if (
    toolName.includes("post") ||
    toolName.includes("publish") ||
    toolName.includes("schedule")
  ) {
    return "external";
  }
  if (inputs.length > 0 || outputs.length > 0) return "artifact";
  return "project";
}

async function recordLifecycle(
  fs: Engine,
  input: {
    slug: string;
    actionId: string;
    actionName: string;
    toolName: string;
    phase: BookActionPhase;
    args: Record<string, unknown>;
    value?: unknown;
  },
): Promise<void> {
  const inputArtifactIds = [...collectArtifactIds(input.args)];
  const inputArtifactIdSet = new Set(inputArtifactIds);
  const outputArtifactIds = [...collectArtifactIds(input.value)]
    .filter((assetId) => !inputArtifactIdSet.has(assetId));
  const targetArtifactId = outputArtifactIds[0] ?? inputArtifactIds[0];
  const recorded = await fs.history.recordBookAction({
    projectSlug: input.slug,
    actionId: input.actionId,
    operation: input.actionName,
    phase: input.phase,
    scope: actionScope(
      input.toolName,
      inputArtifactIds,
      outputArtifactIds,
    ),
    actor: "mcp",
    lane: "mcp",
    inputArtifactIds,
    outputArtifactIds,
    ...(targetArtifactId ? { targetArtifactId } : {}),
    writeSet: input.phase === "completed" && targetArtifactId
      ? [`artifact:${targetArtifactId}`]
      : [],
    details: {
      tool_name: input.toolName,
      arguments: boundedValue(input.args),
      ...(input.value === undefined
        ? {}
        : { result: boundedValue(input.value) }),
    },
  });
  if (!recorded.ok) {
    console.warn(
      `[mcp] project-book record failed for ${input.actionName}: ${recorded.error.message}`,
    );
  }
}

function withLogging(def: ToolDef, fs: Engine): ToolDef {
  return {
    ...def,
    handler: async (args) => {
      const start = performance.now();
      const slug = args.project_slug as string | undefined;
      const shouldRecord = Boolean(slug) && isBookToolActivity(def.name, args);
      const actionName = actionNameForTool(def.name);
      const actionId = randomUUID();
      if (shouldRecord && def.name !== "create_project") {
        try {
          await recordLifecycle(fs, {
            slug: slug!,
            actionId,
            actionName,
            toolName: def.name,
            phase: "requested",
            args,
          });
        } catch (error) {
          console.warn(
            `[mcp] project-book record failed for ${actionName}:`,
            error,
          );
        }
      }
      let result: ToolResult;
      try {
        result = await def.handler(args);
      } catch (error) {
        const ms = Math.round(performance.now() - start);
        console.log(`[mcp] ${def.name} error ${ms}ms`);
        if (shouldRecord && slug && def.name !== "delete_project") {
          try {
            await recordLifecycle(fs, {
              slug,
              actionId,
              actionName,
              toolName: def.name,
              phase: "failed",
              args,
              value: {
                error: error instanceof Error ? error.message : String(error),
              },
            });
          } catch (recordError) {
            console.warn(
              `[mcp] project-book record failed for ${actionName}:`,
              recordError,
            );
          }
        }
        throw error;
      }
      const ms = Math.round(performance.now() - start);

      const status = result.isError ? "error" : "ok";
      const suffix = result.isError
        ? ` ${result.content[0]?.text.slice(0, 80)}`
        : "";
      console.log(`[mcp] ${def.name} ${status} ${ms}ms${suffix}`);

      if (shouldRecord && slug && def.name !== "delete_project") {
        const value = toolResultValue(result);
        try {
          await recordLifecycle(fs, {
            slug,
            actionId,
            actionName,
            toolName: def.name,
            phase: result.isError ? "failed" : "completed",
            args,
            value,
          });
        } catch (error) {
          console.warn(
            `[mcp] project-book record failed for ${actionName}:`,
            error,
          );
        }
      }

      return result;
    },
  };
}

export { withLogging };
