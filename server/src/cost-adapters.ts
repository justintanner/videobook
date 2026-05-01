import type { EstimateRequest } from "@apicity/cost";

export type CostAdapter = (input: Record<string, unknown>) => EstimateRequest | null;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

// xAI / OpenAI text payloads mirror the upstream API body. The cost lib's
// extractor flattens chat/responses payloads to a single string for the
// chars/4 token heuristic, then prices via the bundled rate table.
const xaiText = (model: string, defaultMaxOut?: number): CostAdapter => (input) => {
  const max = num(input.max_output_tokens) ?? defaultMaxOut;
  return {
    provider: "xai",
    payload: {
      model,
      text: str(input.script_text) || str(input.prompt) || str(input.text) || "",
      ...(max !== undefined ? { max_output_tokens: max } : {}),
    },
  };
};

const openaiText = (model: string, defaultMaxOut?: number): CostAdapter => (input) => {
  const max = num(input.max_output_tokens) ?? defaultMaxOut;
  return {
    provider: "openai",
    payload: {
      model,
      input: str(input.prompt) || str(input.text) || "",
      ...(max !== undefined ? { max_output_tokens: max } : {}),
    },
  };
};

// Kie seedance: the cost lib reads payload.input.{resolution, duration} and
// uses payload.input.first_frame_url to discriminate i2v vs t2v. Default
// resolution to "720p" so a bare estimate still returns a price (matches the
// production tool's effective default).
const kieSeedance = (direction: "t2v" | "i2v"): CostAdapter => (input) => {
  const apiModel = str(input.model);
  const model =
    apiModel === "bytedance/seedance-2"
      ? "bytedance/seedance-2"
      : "bytedance/seedance-2-fast";
  return {
    provider: "kie",
    payload: {
      model,
      input: {
        resolution: str(input.resolution) || "720p",
        duration: num(input.duration) ?? num(input.seconds) ?? 5,
        ...(direction === "i2v" ? { first_frame_url: "stub" } : {}),
      },
    },
  };
};

// kling-3.0/video keys by mode + sound (sound===true selects "|sound").
// Defaults match buildKling30VideoPayload in payload-builders.ts.
const kieKling30Video: CostAdapter = (input) => ({
  provider: "kie",
  payload: {
    model: "kling-3.0/video",
    input: {
      mode: str(input.mode) || "std",
      sound: input.sound !== false,
      duration: num(input.duration) ?? 5,
    },
  },
});

// kling-3.0/motion-control keys by mode ("720p" | "1080p"). Audio is not
// separately priced for motion-control.
const kieKling30MotionControl: CostAdapter = (input) => ({
  provider: "kie",
  payload: {
    model: "kling-3.0/motion-control",
    input: {
      mode: str(input.mode) || "720p",
      duration: num(input.duration) ?? 5,
    },
  },
});

// Map MCP tool_name -> EstimateRequest builder. Tools not listed here return
// null from getCostAdapter() and surface in the UI as "—" (no rate available).
// Fal-backed tools have no entry: @apicity/cost dropped fal coverage when it
// switched to a pure-local pricing table.
const ADAPTERS: Record<string, CostAdapter> = {
  // --- text rewrites / chat ---
  rewrite_script: xaiText("grok-4.20-reasoning", 4000),
  rewrite_prompt: openaiText("gpt-5.2", 1000),
  chat: openaiText("gpt-5.4", 2000),
  describe_image: xaiText("grok-4.20-reasoning", 1500),

  // --- KIE per-second video ---
  generate_seedance2_t2v_video: kieSeedance("t2v"),
  generate_seedance2_i2v_video: kieSeedance("i2v"),
  generate_seedance2_frames_video: kieSeedance("i2v"),
  generate_seedance2_reference_video: kieSeedance("i2v"),
  generate_kling30_video: kieKling30Video,
  generate_kling30_motion_control_video: kieKling30MotionControl,
};

export function getCostAdapter(toolName: string): CostAdapter | null {
  return ADAPTERS[toolName] ?? null;
}

export const SUPPORTED_TOOL_NAMES: readonly string[] = Object.keys(ADAPTERS);
