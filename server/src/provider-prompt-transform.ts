import { scanNotebookMentions } from "videobook-engine/notebook-mentions";
import {
  replaceHappyHorseAssetMentions,
  replaceNaturalAssetMentions,
  rewriteImageSlugMentions,
  rewriteImageSlugMentionsToBrackets,
  rewriteSeedanceAssetMentions,
  stripSlugMentions,
} from "./google-flow-refs.js";
import { getCanonicalName } from "./generation-registry.js";

const PROVIDER_MARKER_PATTERNS = [
  /^@element_[a-z0-9_]+$/iu,
  /^@reference(?:Image|Audio)?_\d+$/u,
  /^@character_\d+$/u,
  /^@(Image|Video|Audio)\d+$/u,
  /^@image\d+$/u,
];
const LOCAL_ASSET_MENTION_PATTERN = /^@(img|vid|aud|char|nb)-/iu;

export function isProviderNativeMention(value: string): boolean {
  return PROVIDER_MARKER_PATTERNS.some((pattern) => pattern.test(value));
}

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

export class ProviderPlaceholderError extends Error {
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
    imageSlugs: stringArray(args.image_slugs),
  });
}

export function unresolvedProviderMentions(prompt: string): string[] {
  const leaks = scanNotebookMentions(prompt)
    .filter((mention) => {
      if (mention.kind === "grid") return true;
      if (isProviderNativeMention(mention.raw)) {
        return false;
      }
      return LOCAL_ASSET_MENTION_PATTERN.test(mention.raw);
    })
    .map((mention) => mention.raw);
  return [...new Set(leaks)];
}

export function assertNoUnresolvedMentions(
  prompt: string,
  options: { toolName: string },
): void {
  const tokens = unresolvedProviderMentions(prompt);
  if (tokens.length > 0) throw new ProviderMentionError(options.toolName, tokens);
}

export interface ProviderPromptLeak {
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
    if (value.includes("url.resolved.later.for")) placeholders.push(path);
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
  const imageSlugs = stringArray(args.image_slugs);
  let transformed = prompt;

  switch (toolName) {
    case "generate_kie_kling_3_0_video":
    case "generate_kie_kling_3_0_turbo_video":
    case "generate_kie_nano_banana_pro_text_to_image":
    case "generate_kie_seedream_v5_lite_image_to_image":
    case "generate_kie_qwen_2_0_edit_image":
    case "generate_kie_gpt_image_2_image_to_image":
    case "generate_kie_wan_2_7_text_to_image":
    case "generate_kie_wan_2_7_pro_text_to_image":
    case "generate_xai_grok_imagine_video":
    case "generate_alibaba_wan_2_7_text_to_image":
    case "generate_alibaba_wan_2_7_pro_text_to_image":
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
    case "generate_kie_kling_3_0_motion_control":
      transformed = replaceNaturalAssetMentions(prompt, {
        imageSlugs: stringArray(args.character_image_slugs),
        videoSlugs: stringArray(args.motion_video_slugs),
      });
      break;
    case "generate_kie_seedance_2_0_video":
    case "generate_kie_seedance_2_0_fast_video":
      transformed = stripSlugMentions(
        rewriteSeedanceAssetMentions(prompt, {
          imageSlugs,
          videoSlugs: stringArray(args.video_slugs),
          audioSlugs: stringArray(args.audio_slugs),
        }),
        compact([
          nonempty(args.first_frame_slug),
          nonempty(args.last_frame_slug),
        ]),
      );
      break;
    case "generate_kie_seedance_2_0_mini_video":
      transformed = rewriteSeedanceAssetMentions(prompt, {
        imageSlugs,
        videoSlugs: stringArray(args.video_slugs),
        audioSlugs: stringArray(args.audio_slugs),
      });
      break;
    case "generate_kie_gemini_omni_video":
      transformed = replaceNaturalAssetMentions(prompt, {
        imageSlugs,
        sourceVideoSlug: nonempty(args.video_slug) ?? null,
      });
      break;
    case "generate_google_flow_veo_3_1_quality_video":
    case "generate_google_flow_veo_3_1_fast_video":
    case "generate_google_flow_veo_3_1_lite_video":
    case "generate_google_flow_veo_3_1_lite_low_priority_video":
      transformed = stripSlugMentions(
        rewriteImageSlugMentions(prompt, imageSlugs),
        compact([
          nonempty(args.first_frame_slug),
          nonempty(args.last_frame_slug),
        ]),
      );
      break;
    case "generate_google_flow_omni_flash_video":
      transformed = stripSlugMentions(
        rewriteImageSlugMentions(prompt, imageSlugs),
        compact([
          nonempty(args.video_slug),
          nonempty(args.first_frame_slug),
        ]),
      );
      break;
    case "generate_google_flow_nano_banana_pro_image":
      transformed = rewriteImageSlugMentions(prompt, imageSlugs, "reference");
      break;
    case "generate_kie_wan_2_7_text_to_video":
      transformed = replaceNaturalAssetMentions(prompt, {
        audioSlugs: compact([
          nonempty(args.audio_url) ?? nonempty(args.driving_audio_slug),
        ]),
      });
      break;
    case "generate_kie_wan_2_7_image_to_video":
      transformed = replaceNaturalAssetMentions(prompt, {
        imageSlugs: compact([
          nonempty(args.first_frame_slug),
          nonempty(args.last_frame_slug),
        ]),
        videoSlugs: compact([nonempty(args.first_clip_slug)]),
        audioSlugs: compact([nonempty(args.driving_audio_slug)]),
      });
      break;
    case "generate_kie_wan_2_7_edit_video":
      transformed = replaceNaturalAssetMentions(prompt, {
        videoSlugs: compact([nonempty(args.video_slug)]),
        imageSlugs: compact([nonempty(args.image_slug)]),
      });
      break;
    case "generate_kie_wan_2_7_reference_to_video":
      transformed = replaceNaturalAssetMentions(prompt, {
        imageSlugs: [
          ...imageSlugs,
          ...compact([nonempty(args.first_frame_slug)]),
        ],
        videoSlugs: stringArray(args.video_slugs),
        audioSlugs: compact([nonempty(args.audio_slug)]),
      });
      break;
    case "extend_kie_wan_2_7_video":
      transformed = replaceNaturalAssetMentions(prompt, {
        videoSlugs: compact([nonempty(args.video_slug)]),
      });
      break;
    case "generate_kie_happyhorse_1_1_image_to_video":
      transformed = stripSlugMentions(
        prompt,
        compact([nonempty(args.first_frame_slug)]),
      );
      break;
    case "generate_kie_happyhorse_1_1_reference_to_video":
      transformed = rewriteImageSlugMentionsToBrackets(prompt, imageSlugs);
      break;
    case "generate_kie_happyhorse_1_1_edit_video":
      transformed = replaceHappyHorseAssetMentions(
        prompt,
        nonempty(args.video_slug) ?? null,
        imageSlugs,
      );
      break;
    case "generate_alibaba_wan_2_7_video":
      transformed = replaceNaturalAssetMentions(prompt, {
        imageSlugs: compact([
          nonempty(args.first_frame_slug),
          nonempty(args.last_frame_slug),
        ]),
        videoSlugs: compact([
          nonempty(args.first_clip_slug),
          nonempty(args.video_slug),
        ]),
        audioSlugs: compact([nonempty(args.driving_audio_slug)]),
      });
      break;
  }

  return transformed;
}
