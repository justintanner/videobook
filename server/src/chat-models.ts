import { z } from "zod";
import type { IntelligenceReasoningEffort } from "./openai-intelligence.js";
import type { ToolDef } from "./tools/tool-def.js";

const CHAT_MODEL_IDS = ["gpt-5.6-sol"] as const;

export type ChatModelId = typeof CHAT_MODEL_IDS[number];

export type ChatModelOption = {
  id: ChatModelId;
  label: string;
  description: string;
  reasoningEffort: IntelligenceReasoningEffort;
};

export const DEFAULT_CHAT_MODEL: ChatModelId = "gpt-5.6-sol";

export const CHAT_MODEL_OPTIONS: readonly ChatModelOption[] = [
  {
    id: "gpt-5.6-sol",
    label: "Sol",
    description: "Routes every composer request and configures its tools",
    reasoningEffort: "medium",
  },
];

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
