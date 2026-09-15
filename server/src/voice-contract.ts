export type VoicePhase = "off" | "connecting" | "listening" | "thinking" | "speaking" | "review" | "error";
export type VoiceProvider = "openai" | "xai";
export type VoiceMode = "auto" | VoiceProvider;

export interface VoiceCaption {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  interrupted?: boolean;
}

/**
 * What the speaker asked for about the review already on screen. A revise may
 * change the prompt, the model, any of the review's own settings, or several
 * at once; apply and cancel resolve it.
 */
export interface VoiceReviewCommand {
  decision: "apply" | "cancel" | "revise";
  prompt?: string;
  model?: string;
  settings?: Record<string, string | number | boolean>;
}

export interface VoiceOutcome {
  status: "review" | "completed" | "queued" | "failed" | "cancelled";
  message: string;
}

export type VoiceSessionEvent =
  | { type: "caption"; caption: VoiceCaption }
  | { type: "activity"; phase: "listening" | "thinking"; interrupt?: boolean }
  | { type: "audio"; audio: string; responseId: string; itemId: string }
  | { type: "audio-done"; responseId: string }
  | { type: "action"; callId: string; prompt: string; plan: unknown }
  | { type: "review"; callId: string; command: VoiceReviewCommand }
  | { type: "closed"; reason: string }
  | { type: "error"; message: string };

interface VoiceSessionBase {
  id: string;
  token: string;
  model: string;
  idleTimeoutMs: number;
  fallbackReason?: string;
}

export type VoiceSessionDescriptor = VoiceSessionBase & (
  | { provider: "openai"; transport: "webrtc"; sdp: string }
  | { provider: "xai"; transport: "pcm"; sampleRate: number }
);
