import type { UsdRequest } from "@apicity/cost";

export type CostAdapter = (input: Record<string, unknown>) => UsdRequest | null;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

// XAI text models. The default is the model the corresponding job actually
// uses today; the pricing table may not contain that exact version, in which
// case the cost lib returns usd: 0 with a warning we surface to the user.
const xaiText = (model: string, defaultMaxOut?: number): CostAdapter => (input) => ({
  provider: "xai",
  model,
  text: str(input.script_text) || str(input.prompt) || str(input.text) || "",
  maxOutputTokens: num(input.max_output_tokens) ?? defaultMaxOut,
  useHeuristic: true,
});

const openaiText = (model: string, defaultMaxOut?: number): CostAdapter => (input) => ({
  provider: "openai",
  model,
  text: str(input.prompt) || str(input.text) || "",
  maxOutputTokens: num(input.max_output_tokens) ?? defaultMaxOut,
  useHeuristic: true,
});

const falPassthrough = (endpoint_id: string): CostAdapter => (input) => ({
  provider: "fal",
  endpoint_id,
  payload: input,
});

const kiePerSecond = (model: string): CostAdapter => (input) => ({
  provider: "kie",
  model,
  seconds: num(input.duration) ?? num(input.seconds) ?? 5,
});

// Map from MCP tool_name -> UsdRequest builder. Tools not listed here return
// null from getCostAdapter() and surface in the UI as "—" (no rate available).
const ADAPTERS: Record<string, CostAdapter> = {
  // --- text rewrites / chat ---
  rewrite_script: xaiText("grok-4.20-reasoning", 4000),
  rewrite_prompt: openaiText("gpt-5.2", 1000),
  chat: openaiText("gpt-5.4", 2000),
  describe_image: xaiText("grok-4.20-reasoning", 1500),

  // --- FAL image/video (upstream USD via fal pricing API) ---
  generate_grok_imagine_image_fal: falPassthrough("xai/grok-imagine-image"),
  generate_grok_imagine_image_edit_fal: falPassthrough("xai/grok-imagine-image/edit"),
  generate_grok_imagine_video_i2v_fal: falPassthrough("xai/grok-imagine-video/image-to-video"),
  generate_grok_imagine_video_r2v_fal: falPassthrough("xai/grok-imagine-video/reference-to-video"),
  generate_grok_imagine_video_extend_fal: falPassthrough("xai/grok-imagine-video/extend-video"),
  generate_grok_imagine_video_edit_fal: falPassthrough("xai/grok-imagine-video/edit-video"),
  generate_kling_v3_pro_t2v_fal: falPassthrough("fal-ai/kling-video/v3/pro/text-to-video"),
  generate_kling_v3_pro_i2v_fal: falPassthrough("fal-ai/kling-video/v3/pro/image-to-video"),
  generate_kling_v3_standard_t2v_fal: falPassthrough("fal-ai/kling-video/v3/standard/text-to-video"),
  generate_kling_v3_standard_i2v_fal: falPassthrough("fal-ai/kling-video/v3/standard/image-to-video"),
  generate_nano_banana_fal: falPassthrough("fal-ai/nano-banana"),
  generate_nano_banana_edit_fal: falPassthrough("fal-ai/nano-banana/edit"),
  generate_nano_banana_2_fal: falPassthrough("fal-ai/nano-banana-2"),
  generate_nano_banana_2_edit_fal: falPassthrough("fal-ai/nano-banana-2/edit"),
  generate_nano_banana_pro_fal: falPassthrough("fal-ai/nano-banana-pro"),
  generate_nano_banana_pro_edit_fal: falPassthrough("fal-ai/nano-banana-pro/edit"),
  generate_qwen_image_fal: falPassthrough("fal-ai/qwen-image"),
  generate_qwen_image_edit_fal: falPassthrough("fal-ai/qwen-image/edit"),
  generate_seedance2_t2v_fal: falPassthrough("bytedance/seedance-2.0/text-to-video"),
  generate_seedance2_i2v_fal: falPassthrough("bytedance/seedance-2.0/image-to-video"),
  generate_seedance2_r2v_fal: falPassthrough("bytedance/seedance-2.0/reference-to-video"),
  generate_seedance2_fast_t2v_fal: falPassthrough("bytedance/seedance-2.0/fast/text-to-video"),
  generate_seedance2_fast_i2v_fal: falPassthrough("bytedance/seedance-2.0/fast/image-to-video"),
  generate_seedance2_fast_r2v_fal: falPassthrough("bytedance/seedance-2.0/fast/reference-to-video"),
  generate_seedream_v5_lite_fal: falPassthrough("fal-ai/bytedance/seedream/v5/lite/text-to-image"),
  generate_seedream_v5_lite_edit_fal: falPassthrough("fal-ai/bytedance/seedream/v5/lite/edit"),
  generate_wan27_fal: falPassthrough("fal-ai/wan/v2.7/text-to-image"),
  generate_wan27_edit_fal: falPassthrough("fal-ai/wan/v2.7/edit"),
  generate_wan27_pro_fal: falPassthrough("fal-ai/wan/v2.7/pro/text-to-image"),
  generate_wan27_pro_edit_fal: falPassthrough("fal-ai/wan/v2.7/pro/edit"),
  generate_wan27_t2v_fal: falPassthrough("fal-ai/wan/v2.7/text-to-video"),
  generate_wan27_i2v_fal: falPassthrough("fal-ai/wan/v2.7/image-to-video"),
  generate_wan27_r2v_fal: falPassthrough("fal-ai/wan/v2.7/reference-to-video"),
  generate_wan27_videoedit_fal: falPassthrough("fal-ai/wan/v2.7/edit-video"),

  // --- KIE per-second video (only models present in the cost lib's table) ---
  generate_seedance2_t2v_video: kiePerSecond("seedance-2"),
  generate_seedance2_i2v_video: kiePerSecond("seedance-2"),
  generate_seedance2_frames_video: kiePerSecond("seedance-2"),
  generate_seedance2_reference_video: kiePerSecond("seedance-2"),
  generate_kling30_video: kiePerSecond("kling-3.0"),
  generate_kling30_motion_control_video: kiePerSecond("kling-3.0"),
};

export function getCostAdapter(toolName: string): CostAdapter | null {
  return ADAPTERS[toolName] ?? null;
}

export const SUPPORTED_TOOL_NAMES: readonly string[] = Object.keys(ADAPTERS);
