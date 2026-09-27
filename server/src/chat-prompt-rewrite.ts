/**
 * Guide-backed prompt rewrite for chat- and voice-routed generations.
 *
 * The router answers with a tool plus a prompt string, and left alone that
 * string is often the speaker's sentence verbatim. Routing language then
 * reaches the provider as content: "make a Seedance video of the kittens"
 * transcribes as "make a sea dance video of the kittens" and the model renders
 * an ocean. The notebook path already avoids this with a rewrite_prompt cell
 * (notebook-workflow.ts); this runs the same rewrite on the chat path, before
 * the confirm sheet, so the prompt under review is the prompt the provider
 * sees.
 *
 * Two rules make the rewrite safe to run unattended: @ mention tokens must
 * survive it untouched, because the provider transform resolves them into
 * positional markers afterwards and a dropped token silently drops a
 * reference; and any failure keeps the original prompt, because a rewrite is
 * an improvement, never a precondition.
 */
import type { Engine } from "videobook-engine";
import { getCanonicalName } from "./generation-registry.js";
import { unresolvedProviderMentions } from "./provider-prompt-transform.js";
import { rewritePromptDef } from "./tools/rewrite-prompt.js";
import type { ToolResult } from "./tools/tool-def.js";

/** A `rewrite_prompt` model key, i.e. one of the prompting guides on disk. */
export type RewriteGuideModel =
  | "nano_banana"
  | "gpt_image"
  | "kling30"
  | "grok_imagine"
  | "grok_image"
  | "seedance2"
  | "seedance25";

// Canonical generation action -> the guide that describes how to prompt it.
// Keyed on canonical names only; getCanonicalName folds the legacy aliases in
// first. A tool absent here has no guide, so its prompt goes through
// untouched rather than being rewritten against someone else's grammar.
const GUIDE_BY_CANONICAL_TOOL: Record<string, RewriteGuideModel> = {
  generate_kie_seedance_2_5_video: "seedance25",

  generate_kie_seedance_2_0_video: "seedance2",
  generate_kie_seedance_2_0_fast_video: "seedance2",
  generate_kie_seedance_2_0_mini_video: "seedance2",
  generate_fal_seedance_2_0_text_to_video: "seedance2",
  generate_fal_seedance_2_0_image_to_video: "seedance2",
  generate_fal_seedance_2_0_reference_to_video: "seedance2",
  generate_fal_seedance_2_0_fast_text_to_video: "seedance2",
  generate_fal_seedance_2_0_fast_image_to_video: "seedance2",
  generate_fal_seedance_2_0_fast_reference_to_video: "seedance2",

  generate_kie_kling_3_0_video: "kling30",
  generate_kie_kling_3_0_turbo_video: "kling30",
  generate_kie_kling_3_0_motion_control: "kling30",
  generate_kie_kling_3_0_omni_text_to_video: "kling30",
  generate_kie_kling_3_0_omni_image_to_video: "kling30",
  generate_kie_kling_3_0_omni_reference_to_video: "kling30",
  generate_kie_kling_3_0_omni_transformation: "kling30",
  generate_fal_kling_video_v3_pro_text_to_video: "kling30",
  generate_fal_kling_video_v3_pro_image_to_video: "kling30",
  generate_fal_kling_video_v3_standard_text_to_video: "kling30",
  generate_fal_kling_video_v3_standard_image_to_video: "kling30",

  generate_kie_nano_banana_pro_text_to_image: "nano_banana",
  generate_google_flow_nano_banana_pro_image: "nano_banana",
  generate_fal_nano_banana_pro_text_to_image: "nano_banana",
  generate_fal_nano_banana_pro_edit_image: "nano_banana",
  generate_fal_nano_banana_text_to_image: "nano_banana",
  generate_fal_nano_banana_edit_image: "nano_banana",
  generate_fal_nano_banana_2_text_to_image: "nano_banana",
  generate_fal_nano_banana_2_edit_image: "nano_banana",
  generate_fal_nano_banana_2_lite_text_to_image: "nano_banana",
  generate_fal_nano_banana_2_lite_edit_image: "nano_banana",

  generate_kie_gpt_image_2_5_flare_image: "gpt_image",
  generate_kie_gpt_image_2_5_sunburst_image: "gpt_image",

  generate_kie_grok_imagine_text_to_video: "grok_imagine",
  generate_kie_grok_imagine_image_to_video: "grok_imagine",
  generate_xai_grok_imagine_video: "grok_imagine",
  generate_fal_grok_imagine_video_image_to_video: "grok_imagine",
  generate_fal_grok_imagine_video_reference_to_video: "grok_imagine",
  generate_fal_grok_imagine_video_edit_video: "grok_imagine",

  generate_kie_grok_imagine_text_to_image: "grok_image",
  generate_kie_grok_imagine_image_to_image: "grok_image",
  generate_fal_grok_imagine_text_to_image: "grok_image",
  generate_fal_grok_imagine_edit_image: "grok_image",
};

// Rides on rewrite_prompt's custom_prompt, which caps at 500 characters. The
// mention rule protects the reference wiring; the model-name rule is the reason
// this call exists at all; the settings rule keeps the guide from narrating
// duration and framing into the text when those ride their own payload fields.
export const CHAT_REWRITE_INSTRUCTION =
  "Keep every @ reference token byte-for-byte as written (e.g. @a1, "
  + "@0199f0e4-9332-7383-b1a9-eb016abd4fdb): never renumber one, never rewrite "
  + "one into @Image1/@Video1/@Audio1 form, never drop one. "
  + "Describe only the media to produce: drop request preambles and any "
  + "instruction naming which model, provider or tool to use. "
  + "Do not state duration, aspect ratio or resolution — those ride their own "
  + "fields, not the prompt.";

/** The prompting guide for a routed generation tool, or null when it has none. */
export function rewriteGuideForTool(tool: string): RewriteGuideModel | null {
  return GUIDE_BY_CANONICAL_TOOL[getCanonicalName(tool)] ?? null;
}

/** Every @ token the rewrite has to hand back. Same scanner the provider
 *  transform uses to find tokens it still has to resolve, so the two agree on
 *  what counts as a mention. */
function mentionTokens(prompt: string): string[] {
  return unresolvedProviderMentions(prompt);
}

/**
 * The rewrite to use, which is the original whenever the rewritten text is
 * blank or has lost a mention. Exported for the tests that cover the guard
 * without spending a model call.
 */
export function usableRewrite(original: string, rewritten: string): string {
  const candidate = rewritten.trim();
  if (!candidate) return original;
  const kept = mentionTokens(candidate);
  const missing = mentionTokens(original).filter((token) => !kept.includes(token));
  return missing.length > 0 ? original : candidate;
}

type RewritePromptOutput = { rewritten_prompt?: unknown };

function rewrittenPromptFromResult(result: ToolResult): string {
  const text = result.isError ? undefined : result.content[0]?.text;
  if (text === undefined) return "";
  const { rewritten_prompt: rewritten } = JSON.parse(text) as RewritePromptOutput;
  return typeof rewritten === "string" ? rewritten : "";
}

/**
 * Rewrite a routed generation prompt against its model's guide. Returns the
 * original prompt when the tool has no guide, when the rewrite fails, and when
 * the result would cost a mention — this sits between routing and the confirm
 * sheet, so it must never be the thing that stops a generation.
 */
export async function rewriteChatGenerationPrompt(
  engine: Engine,
  input: { bookId: string; tool: string; prompt: string },
): Promise<string> {
  const model = rewriteGuideForTool(input.tool);
  if (!model || !input.prompt.trim()) return input.prompt;
  try {
    const result = await rewritePromptDef(engine).handler({
      book_id: input.bookId,
      prompt: input.prompt,
      model,
      custom_prompt: CHAT_REWRITE_INSTRUCTION,
    });
    return usableRewrite(input.prompt, rewrittenPromptFromResult(result));
  } catch {
    return input.prompt;
  }
}
