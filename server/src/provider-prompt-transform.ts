import { scanNotebookMentions } from "videobook-engine/notebook-mentions";
import {
  replaceHappyHorseAssetMentions,
  replaceNaturalAssetMentions,
  rewriteImageRefMentions,
  rewriteImageRefMentionsToBrackets,
  rewriteSeedanceAssetMentions,
  stripRefMentions,
} from "./google-flow-refs.js";
import { getCanonicalName } from "./generation-registry.js";
import { PREVIEW_PLACEHOLDER_HOST } from "./preview-payload.js";

// An @<artifact-id> token is the internal reference currency between the
// grid resolver and the per-tool dialect rewrite; one surviving into a
// provider payload means the rewrite missed it.
const ARTIFACT_ID_MENTION_PATTERN =
  /@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\w-])/giu;

export class ProviderMentionError extends Error {
  readonly tokens: string[];
  readonly toolName: string;

  constructor(toolName: string, tokens: string[]) {
    super(
      `Unresolved provider mention${tokens.length === 1 ? "" : "s"} `
      + `${tokens.join(", ")} in ${toolName}`,
    );
    this.name = "ProviderMentionError";
    this.tokens = tokens;
    this.toolName = toolName;
  }
}

class ProviderPlaceholderError extends Error {
  readonly paths: string[];
  readonly toolName: string;

  constructor(toolName: string, paths: string[]) {
    super(`Preview placeholder URL reached wire payload for ${toolName}: ${paths.join(", ")}`);
    this.name = "ProviderPlaceholderError";
    this.paths = paths;
    this.toolName = toolName;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonempty(value: unknown): string | undefined {
  const text = optionalString(value)?.trim();
  return text ? text : undefined;
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => value !== undefined);
}

function naturalImagePrompt(prompt: string, args: Record<string, unknown>): string {
  return replaceNaturalAssetMentions(prompt, {
    imageRefs: stringArray(args.image_refs),
  });
}

export function unresolvedProviderMentions(prompt: string): string[] {
  const leaks = [
    ...scanNotebookMentions(prompt).map((mention) => mention.raw),
    ...[...prompt.matchAll(ARTIFACT_ID_MENTION_PATTERN)].map(
      (match) => match[0],
    ),
  ];
  return [...new Set(leaks)];
}

export function assertNoUnresolvedMentions(
  prompt: string,
  options: { toolName: string },
): void {
  const tokens = unresolvedProviderMentions(prompt);
  if (tokens.length > 0) throw new ProviderMentionError(options.toolName, tokens);
}

interface ProviderPromptLeak {
  path: string;
  token: string;
}

function visitProviderPayload(
  value: unknown,
  path: string,
  key: string,
  leaks: ProviderPromptLeak[],
  placeholders: string[],
): void {
  if (typeof value === "string") {
    if (value.includes(PREVIEW_PLACEHOLDER_HOST)) placeholders.push(path);
    if (key.toLowerCase().includes("prompt") || key === "text") {
      for (const token of unresolvedProviderMentions(value)) {
        leaks.push({ path, token });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      visitProviderPayload(item, `${path}[${index}]`, key, leaks, placeholders);
    });
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    visitProviderPayload(
      childValue,
      path ? `${path}.${childKey}` : childKey,
      childKey,
      leaks,
      placeholders,
    );
  }
}

export function inspectProviderPayload(value: unknown): {
  promptLeaks: ProviderPromptLeak[];
  placeholderPaths: string[];
} {
  const promptLeaks: ProviderPromptLeak[] = [];
  const placeholderPaths: string[] = [];
  visitProviderPayload(value, "", "", promptLeaks, placeholderPaths);
  return { promptLeaks, placeholderPaths };
}

export function assertProviderPayload(
  value: unknown,
  options: { toolName: string; wire?: boolean },
): void {
  const inspection = inspectProviderPayload(value);
  const tokens = [...new Set(inspection.promptLeaks.map((leak) => leak.token))];
  if (tokens.length > 0) throw new ProviderMentionError(options.toolName, tokens);
  if (options.wire && inspection.placeholderPaths.length > 0) {
    throw new ProviderPlaceholderError(
      options.toolName,
      inspection.placeholderPaths,
    );
  }
}

export function transformProviderPrompt(
  rawToolName: string,
  args: Record<string, unknown>,
  provider?: string,
): string | undefined {
  const prompt = optionalString(args.prompt);
  if (prompt === undefined) return undefined;
  const toolName = getCanonicalName(rawToolName);
  const imageRefs = stringArray(args.image_refs);
  let transformed = prompt;

  switch (toolName) {
    case "generate_kie_kling_3_0_omni_text_to_video":
    case "generate_kie_kling_3_0_omni_image_to_video":
    case "generate_kie_kling_3_0_video":
    case "generate_kie_kling_3_0_turbo_video":
    case "generate_kie_nano_banana_pro_text_to_image":
    case "generate_kie_seedream_v5_lite_image_to_image":
    case "generate_kie_qwen_2_0_edit_image":
    case "generate_kie_gpt_image_2_image_to_image":
    case "generate_xai_grok_imagine_video":
      transformed = naturalImagePrompt(prompt, args);
      break;
    case "generate_kie_grok_imagine_image_to_image":
      transformed = naturalImagePrompt(prompt, args);
      break;
    case "generate_kie_grok_imagine_image_to_video":
      transformed = provider?.startsWith("xai")
        ? naturalImagePrompt(prompt, args)
        : prompt;
      break;
    case "generate_kie_kling_3_0_omni_reference_to_video":
    case "generate_kie_kling_3_0_omni_transformation":
      transformed = replaceNaturalAssetMentions(prompt, {
        imageRefs,
        videoRefs: stringArray(args.video_refs),
      });
      break;
    case "generate_kie_kling_3_0_motion_control":
      transformed = replaceNaturalAssetMentions(prompt, {
        imageRefs: stringArray(args.character_image_refs),
        videoRefs: stringArray(args.motion_video_refs),
      });
      break;
    case "generate_kie_seedance_2_5_video":
    case "generate_kie_seedance_2_0_video":
    case "generate_kie_seedance_2_0_fast_video":
    case "generate_kie_wan_3_0_video":
    case "generate_kie_wan_3_0_prime_video":
      transformed = stripRefMentions(
        rewriteSeedanceAssetMentions(prompt, {
          imageRefs,
          videoRefs: stringArray(args.video_refs),
          audioRefs: stringArray(args.audio_refs),
        }),
        compact([
          nonempty(args.first_frame_ref),
          nonempty(args.last_frame_ref),
        ]),
      );
      break;
    case "generate_kie_seedance_2_0_mini_video":
      transformed = rewriteSeedanceAssetMentions(prompt, {
        imageRefs,
        videoRefs: stringArray(args.video_refs),
        audioRefs: stringArray(args.audio_refs),
      });
      break;
    case "generate_kie_gemini_omni_video":
      transformed = replaceNaturalAssetMentions(prompt, {
        imageRefs,
        sourceVideoRef: nonempty(args.video_ref) ?? null,
      });
      break;
    case "generate_google_flow_veo_3_1_quality_video":
    case "generate_google_flow_veo_3_1_fast_video":
    case "generate_google_flow_veo_3_1_lite_video":
    case "generate_google_flow_veo_3_1_lite_low_priority_video":
      transformed = stripRefMentions(
        rewriteImageRefMentions(prompt, imageRefs),
        compact([
          nonempty(args.first_frame_ref),
          nonempty(args.last_frame_ref),
        ]),
      );
      break;
    case "generate_google_flow_omni_flash_video":
      transformed = stripRefMentions(
        rewriteImageRefMentions(prompt, imageRefs),
        compact([
          nonempty(args.video_ref),
          nonempty(args.first_frame_ref),
        ]),
      );
      break;
    case "generate_google_flow_nano_banana_pro_image":
      transformed = rewriteImageRefMentions(prompt, imageRefs, "reference");
      break;
    case "generate_kie_omnihuman_1_5_video":
      transformed = replaceNaturalAssetMentions(prompt, {
        imageRefs: compact([nonempty(args.image_ref)]),
        audioRefs: compact([nonempty(args.audio_ref)]),
      });
      break;
    case "generate_kie_minimax_h3_image_to_video":
      transformed = stripRefMentions(
        prompt,
        compact([
          nonempty(args.first_frame_ref),
          nonempty(args.last_frame_ref),
        ]),
      );
      break;
    case "generate_kie_minimax_h3_reference_to_video":
      transformed = replaceNaturalAssetMentions(prompt, {
        imageRefs,
        videoRefs: stringArray(args.video_refs),
        audioRefs: stringArray(args.audio_refs),
      });
      break;
    case "generate_kie_happyhorse_1_1_image_to_video":
      transformed = stripRefMentions(
        prompt,
        compact([nonempty(args.first_frame_ref)]),
      );
      break;
    case "generate_kie_happyhorse_1_1_reference_to_video":
      transformed = rewriteImageRefMentionsToBrackets(prompt, imageRefs);
      break;
    case "generate_kie_happyhorse_1_1_edit_video":
      transformed = replaceHappyHorseAssetMentions(
        prompt,
        nonempty(args.video_ref) ?? null,
        imageRefs,
      );
      break;
  }

  return transformed;
}
