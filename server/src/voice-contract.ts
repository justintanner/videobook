export type VoicePhase = "off" | "connecting" | "listening" | "thinking" | "speaking" | "review" | "error";

export interface VoiceCaption {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  interrupted?: boolean;
}

export interface VoiceOutcome {
  status: "review" | "completed" | "queued" | "failed" | "cancelled";
  message: string;
}

export type VoiceSessionEvent =
  | { type: "caption"; caption: VoiceCaption }
  | { type: "activity"; phase: "listening" | "thinking" }
  | { type: "action"; callId: string; prompt: string; plan: unknown }
  | { type: "closed"; reason: string }
  | { type: "error"; message: string };

export interface VoiceSessionDescriptor {
  id: string;
  token: string;
  sdp: string;
  model: string;
  idleTimeoutMs: number;
}
