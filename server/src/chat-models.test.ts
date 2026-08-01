import { describe, expect, it } from "vitest";
import {
  CHAT_MODEL_OPTIONS,
  DEFAULT_CHAT_MODEL,
  listChatModelsDef,
  resolveChatModel,
} from "./chat-models.js";

describe("chat models", () => {
  it("offers deep and fast routing while preserving the current default", () => {
    expect(DEFAULT_CHAT_MODEL).toBe("gpt-5.6-sol");
    expect(CHAT_MODEL_OPTIONS.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(resolveChatModel("gpt-5.6-terra")).toMatchObject({
      id: "gpt-5.6-terra",
      reasoningEffort: "low",
    });
  });

  it("publishes a client-safe catalog through MCP", async () => {
    const result = await listChatModelsDef().handler({});
    const catalog = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(catalog).toEqual({
      defaultModel: "gpt-5.6-sol",
      models: CHAT_MODEL_OPTIONS.map(({ id, label, description }) => ({
        id,
        label,
        description,
      })),
    });
  });
});
