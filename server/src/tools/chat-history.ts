import type { Engine } from "videobook-engine";
import type { VoiceCaption } from "../voice-contract.js";

export async function appendVoiceHistory(engine: Engine, input: VoiceCaption & { sessionId: string; notebookId?: string; model: string }): Promise<void> {
  const result = await engine.logs.append("voice-chat", { ...input, ts: Date.now() });
  if (!result.ok) throw new Error(result.error.message);
}
