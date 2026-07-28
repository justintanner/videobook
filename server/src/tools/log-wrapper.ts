import { v7 as uuidv7 } from "uuid";
import type {
  Engine,
  HistoryActionPhase,
  HistoryActionScope,
} from "videobook-engine";
import { actionNameForTool, isBookToolActivity } from "./activity-policy.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const ARTIFACT_REFERENCE = /^@?(?:img|vid|aud|script|char|prompt|scn|final)-[a-zA-Z0-9._-]+$/;

function toolResultValue(result: ToolResult): unknown {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isNotebookCellRecord(value: Record<string, unknown>): boolean {
  return typeof value.id === "string"
    && typeof value.type === "string"
    && typeof value.slug === "string"
    && typeof value.slot === "object"
    && value.slot !== null;
}

function collectArtifactIds(
  value: unknown,
  found = new Set<string>(),
  path: string[] = [],
): Set<string> {
  if (typeof value === "string" && ARTIFACT_REFERENCE.test(value)) {
    found.add(value.replace(/^@/, ""));
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactIds(item, found, path);
    return found;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const notebookCell = isNotebookCellRecord(record);
    for (const [key, nested] of Object.entries(record)) {
      if (
        key === "cell_slug"
        || (key === "slug" && (notebookCell || path.at(-1) === "cell"))
      ) {
        continue;
      }
      collectArtifactIds(nested, found, [...path, key]);
    }
  }
  return found;
}

function boundedValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 32_000) return value;
  return { truncated: true, bytes: Buffer.byteLength(serialized) };
}

function actionScope(
  toolName: string,
  inputs: string[],
  outputs: string[],
): HistoryActionScope {
  if (toolName.includes("post") || toolName.includes("publish") || toolName.includes("schedule")) {
    return "external";
  }
  return inputs.length > 0 || outputs.length > 0 ? "artifact" : "book";
}

async function recordLifecycle(
  engine: Engine,
  input: {
    actionId: string;
    actionName: string;
    toolName: string;
    phase: HistoryActionPhase;
    args: Record<string, unknown>;
    value?: unknown;
  },
): Promise<void> {
  const inputArtifactIds = [...collectArtifactIds(input.args)];
  const inputs = new Set(inputArtifactIds);
  const outputArtifactIds = [...collectArtifactIds(input.value)]
    .filter((artifactId) => !inputs.has(artifactId));
  const targetArtifactId = outputArtifactIds[0] ?? inputArtifactIds[0];
  const result = await engine.history.recordAction({
    actionId: input.actionId,
    operation: input.actionName,
    phase: input.phase,
    scope: actionScope(input.toolName, inputArtifactIds, outputArtifactIds),
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
      ...(input.value === undefined ? {} : { result: boundedValue(input.value) }),
    },
  });
  if (!result.ok) console.warn(`[mcp] history record failed for ${input.actionName}: ${result.error.message}`);
}

export function withLogging(def: ToolDef, engine: Engine): ToolDef {
  return {
    ...def,
    handler: async (args) => {
      const startedAt = performance.now();
      const shouldRecord = def.recordsOwnActivity !== true
        && def.scope !== "global"
        && isBookToolActivity(def.name, args);
      const actionName = actionNameForTool(def.name);
      const actionId = uuidv7();
      if (shouldRecord) {
        await recordLifecycle(engine, {
          actionId,
          actionName,
          toolName: def.name,
          phase: "requested",
          args,
        });
      }
      try {
        const result = await def.handler(args);
        console.log(`[mcp] ${def.name} ${result.isError ? "error" : "ok"} ${Math.round(performance.now() - startedAt)}ms`);
        if (shouldRecord) {
          await recordLifecycle(engine, {
            actionId,
            actionName,
            toolName: def.name,
            phase: result.isError ? "failed" : "completed",
            args,
            value: toolResultValue(result),
          });
        }
        return result;
      } catch (cause) {
        if (shouldRecord) {
          await recordLifecycle(engine, {
            actionId,
            actionName,
            toolName: def.name,
            phase: "failed",
            args,
            value: { error: cause instanceof Error ? cause.message : String(cause) },
          });
        }
        throw cause;
      }
    },
  };
}
