import { z } from "zod";
import type { CostEstimate, CostHints } from "@apicity/cost";
import type { Engine } from "videobook-engine";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { getCostProvider } from "../cost.js";
import type { BookManager } from "../book-manager.js";
import { referenceVideoDuration } from "../reference-video-duration.js";
import { previewPlaceholderUrl } from "../preview-payload.js";
import { DEFAULT_IMAGE_EDIT_MODEL_ID, findImageEditModel } from "../image-edit-models.js";
import { tryResolveModel } from "../media/descriptor.js";
import { estimateGeneration } from "../media/cost.js";
import { checkSeedanceEditSource, normalizeRefs } from "../media/refs.js";
import { REF_ROLES, type MediaRefs } from "../media/types.js";

const GENERATION_TOOLS = new Set(["generate_image", "generate_video", "generate_audio"]);
const REWRITE_MODEL = "gpt-5.6-sol";

const callItem = z.object({
  tool_name: z.string().describe("Tool whose cost to estimate: generate_image, generate_video, generate_audio, edit_image_subjects or rewrite_prompt"),
  input: z.record(z.string(), z.unknown()).describe("Same arguments object you'd pass to the tool"),
});

const schema = {
  calls: z
    .array(callItem)
    .min(1)
    .describe("One or more (tool_name, input) pairs. The result sums all entries."),
};

const FREE_ESTIMATE: CostEstimate = {
  usd: 0,
  currency: "USD",
  source: "free",
  breakdown: {},
  rateAsOf: null,
  warnings: [],
};

function unavailable(warning: string): CostEstimate {
  return { ...FREE_ESTIMATE, warnings: [warning] };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function placeholderRefs(refs: MediaRefs): MediaRefs {
  const placeholders: MediaRefs = {};
  for (const role of REF_ROLES) {
    const list = refs[role];
    if (list) placeholders[role] = list.map((ref) => ref.startsWith("http") ? ref : previewPlaceholderUrl(ref));
  }
  return placeholders;
}

async function sourceDuration(engine: Engine, refs: readonly string[]): Promise<number | undefined> {
  for (const ref of refs) {
    const meta = await engine.metadata.artifacts.read<{ duration?: unknown }>(ref.replace(/^@/, ""), "original");
    if (meta.ok && typeof meta.value?.duration === "number" && meta.value.duration > 0) return meta.value.duration;
  }
  return undefined;
}

async function mediaHints(engine: Engine, refs: MediaRefs): Promise<CostHints> {
  const videos = (refs.video ?? []).filter((ref) => !ref.startsWith("http"));
  const videoSeconds = videos.length > 0 ? await referenceVideoDuration(engine, videos) : undefined;
  if (videoSeconds !== undefined) return { inputDurationSeconds: videoSeconds };
  const audioSeconds = await sourceDuration(engine, (refs.audio ?? []).filter((ref) => !ref.startsWith("http")));
  return audioSeconds === undefined ? {} : { inputDurationSeconds: audioSeconds };
}

async function estimateMedia(engine: Engine, input: Record<string, unknown>): Promise<CostEstimate> {
  const modelId = text(input.model);
  const model = modelId ? tryResolveModel(modelId) : null;
  if (!model) return unavailable(`unknown model '${modelId ?? ""}'`);
  const refs = normalizeRefs(input.refs);
  const options = input.options !== null && typeof input.options === "object" && !Array.isArray(input.options)
    ? input.options as Record<string, unknown>
    : {};
  const sourceError = await checkSeedanceEditSource(engine, model, refs, input.mode);
  if (sourceError) return unavailable(sourceError);
  const result = await estimateGeneration(model, {
    prompt: text(input.prompt),
    refUrls: placeholderRefs(refs),
    options,
    mode: text(input.mode),
  }, await mediaHints(engine, refs));
  return result.ok ? result.estimate : unavailable(result.error);
}

async function estimateImageEdit(input: Record<string, unknown>): Promise<CostEstimate> {
  if (input.model === "sharp/layer-composite" && input.operation === "remove") return { ...FREE_ESTIMATE };
  const editModel = findImageEditModel(text(input.model) ?? DEFAULT_IMAGE_EDIT_MODEL_ID);
  const model = editModel ? tryResolveModel(editModel.catalogModel) : null;
  if (!model) return unavailable(`unknown image edit model '${String(input.model)}'`);
  const imageCount = Array.isArray(input.image_refs) && input.image_refs.length > 0 ? input.image_refs.length : 1;
  const result = await estimateGeneration(model, {
    prompt: text(input.prompt) ?? "edit",
    refUrls: { image: Array.from({ length: imageCount }, (_, index) => `https://example.test/edit-${index + 1}.png`) },
  });
  return result.ok ? result.estimate : unavailable(result.error);
}

function estimateRewrite(input: Record<string, unknown>): CostEstimate {
  return getCostProvider().estimate({
    provider: "openai",
    payload: { model: REWRITE_MODEL, input: text(input.prompt) ?? text(input.text) ?? "", max_output_tokens: 1000 },
  });
}

async function estimateOne(engine: Engine, toolName: string, input: Record<string, unknown>): Promise<CostEstimate> {
  if (GENERATION_TOOLS.has(toolName)) return estimateMedia(engine, input);
  if (toolName === "edit_image_subjects") return estimateImageEdit(input);
  if (toolName === "rewrite_prompt") return estimateRewrite(input);
  return unavailable(`no cost adapter registered for tool '${toolName}'`);
}

function sumEstimates(estimates: CostEstimate[]): CostEstimate {
  if (estimates.length === 1) return estimates[0]!;
  const usd = estimates.reduce((acc, e) => acc + e.usd, 0);
  const warnings = estimates.flatMap((e) => e.warnings);
  const allFree = estimates.every((e) => e.source === "free");
  const sources = new Set(estimates.map((e) => e.source));
  return {
    usd,
    currency: "USD",
    source: allFree ? "free" : sources.size === 1 ? estimates[0]!.source : "tokens-heuristic+table",
    breakdown: {},
    rateAsOf: estimates.find((e) => e.rateAsOf)?.rateAsOf ?? null,
    warnings,
  };
}

export function estimateCostDef(engine: Engine, books?: BookManager): ToolDef {
  let injectedBookId: string | null = null;
  try {
    injectedBookId = engine.book.get().bookId;
  } catch {
    injectedBookId = null;
  }

  const estimateCall = async (call: { tool_name: string; input: Record<string, unknown> }) => {
    const bookId = call.input.book_id;
    if (typeof bookId !== "string" || !bookId || bookId === injectedBookId) {
      return estimateOne(engine, call.tool_name, call.input);
    }
    if (!books) throw new Error(`Book not found: ${bookId}`);
    const book = await books.ensure(bookId);
    if (!book.ok) throw new Error(book.error.message);
    return estimateOne(book.value.engine, call.tool_name, call.input);
  };

  return {
    name: "estimate_cost",
    description:
      "Estimate the USD cost of one or more generate_image, generate_video or generate_audio calls, given as {tool_name, input}, before running them. Dynamically billed fal models use fal's historical average per call when FAL_ADMIN_API_KEY is set, and that estimate warns that it ignores the request. Without that key, or without a published rate, the estimate is $0 with a warning.",
    schema,
    handler: async (args): Promise<ToolResult> => {
      const calls = args.calls as Array<{ tool_name: string; input: Record<string, unknown> }>;
      let estimates: CostEstimate[];
      try {
        estimates = await Promise.all(calls.map(estimateCall));
      } catch (cause) {
        return {
          isError: true,
          content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }],
        };
      }
      const total = sumEstimates(estimates);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            estimate: total,
            per_call: estimates.map((e: CostEstimate, i: number) => ({ tool_name: calls[i]!.tool_name, estimate: e })),
          }),
        }],
      };
    },
  };
}
