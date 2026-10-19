import { scanNotebookMentions } from "videobook-engine/notebook-mentions";
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

function inspectProviderPayload(value: unknown): {
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
