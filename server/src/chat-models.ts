import { z } from "zod";
import type { IntelligenceReasoningEffort } from "./openai-intelligence.js";
import type { ToolDef } from "./tools/tool-def.js";

const CHAT_MODEL_IDS = ["gpt-6-astra"] as const;

export type ChatModelId = typeof CHAT_MODEL_IDS[number];

type ChatModelOption = {
  id: ChatModelId;
  label: string;
  description: string;
  reasoningEffort: IntelligenceReasoningEffort;
};

export const DEFAULT_CHAT_MODEL: ChatModelId = "gpt-6-astra";

export const CHAT_MODEL_OPTIONS: readonly ChatModelOption[] = [
  {
    id: "gpt-6-astra",
    label: "Astra",
    description: "Routes every composer request and configures its tools",
    reasoningEffort: "medium",
  },
];

export function chatIntelligenceRequestOptions(
  model?: ChatModelId,
): { model: ChatModelId; reasoningEffort: IntelligenceReasoningEffort } {
  const resolved = resolveChatModel(model);
  return {
    model: resolved.id,
    reasoningEffort: resolved.reasoningEffort,
  };
}

export const chatModelSchema = z.enum(CHAT_MODEL_IDS);

export function resolveChatModel(model: ChatModelId | undefined): ChatModelOption {
  return CHAT_MODEL_OPTIONS.find((option) => option.id === model)
    ?? CHAT_MODEL_OPTIONS[0];
}

export function listChatModelsDef(): ToolDef {
  return {
    name: "list_chat_models",
    description: "List supported chat routing models and the default selection",
    scope: "global",
    schema: {},
    handler: async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({
          defaultModel: DEFAULT_CHAT_MODEL,
          models: CHAT_MODEL_OPTIONS.map(({ id, label, description }) => ({
            id,
            label,
            description,
          })),
        }),
      }],
    }),
  };
}
