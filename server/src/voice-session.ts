import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createOpenAi, OpenAiError } from "@apicity/openai";
import type { OpenAiRealtimeCallResponse } from "@apicity/openai";
import { connectOpenAiRealtime } from "@apicity/openai/realtime";
import type { OpenAiRealtimeClientEvent, OpenAiRealtimeServerEvent } from "@apicity/openai/realtime";
import { XaiError } from "@apicity/xai";
import { connectXaiRealtime } from "@apicity/xai/realtime";
import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { BookManager } from "./book-manager.js";
import { getApiKey } from "./api-key.js";
import { withBookContext } from "./book-context.js";
import { discoverVoiceActions, voiceWorkspaceContext } from "./voice-actions.js";
import { DEFAULT_VOICE_MODEL, DEFAULT_XAI_VOICE_MODEL, VOICE_PCM_RATE, voiceSessionConfig, xaiVoiceSessionConfig } from "./voice-config.js";
import { chatActionPlanSchema, prepareVoiceChatAction } from "./tools/chat.js";
import { appendVoiceHistory } from "./tools/chat-history.js";
import { appendDiagnostic } from "./diagnostics.js";
import { VoiceReplyProgress } from "./voice-reply-progress.js";
import type { VoiceCaption, VoiceMode, VoiceOutcome, VoiceProvider, VoiceReviewCommand, VoiceSessionDescriptor, VoiceSessionEvent } from "./voice-contract.js";

type VoiceControlEvent = Exclude<OpenAiRealtimeClientEvent, { type: "session.update" }>;
interface VoiceControl {
  send(event: VoiceControlEvent): void;
  close(): void;
  readonly closed: Promise<void>;
}
export type VoiceInputRate = 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;

class VoiceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const providerErrorSchema = z.object({ code: z.string().nullish(), type: z.string().nullish() });
const quotaMessage = "OpenAI API quota is exhausted. Check credits and usage limits in OpenAI settings before restarting voice.";
const rateLimitMessage = "OpenAI is temporarily rate limiting voice. Wait before starting voice again.";
const providerMessages = new Map([
  ["credit_balance_exhausted", "OpenAI API credits are exhausted. Add credits in OpenAI billing, then start voice again."],
  ["organization_spend_limit_exceeded", "The OpenAI organization spend limit has been reached. Review the limit in OpenAI settings before restarting voice."],
  ["project_spend_limit_exceeded", "The OpenAI project spend limit has been reached. Review the project limit in OpenAI settings before restarting voice."],
  ["organization_usage_limit_exceeded", "The OpenAI organization usage limit has been reached. Review usage limits in OpenAI settings before restarting voice."],
  ["insufficient_quota", quotaMessage],
  ["rate_limit_exceeded", rateLimitMessage],
  ["slow_down", rateLimitMessage],
]);

function providerErrorMessage(details: unknown, fallbackCode?: string, provider: VoiceProvider = "openai"): string | undefined {
  const parsed = providerErrorSchema.safeParse(details);
  const code = (parsed.success ? parsed.data.code : undefined) ?? fallbackCode;
  const message = (code ? providerMessages.get(code) : undefined)
    ?? (parsed.success && parsed.data.type === "insufficient_quota" ? quotaMessage : undefined)
    ?? (parsed.success && parsed.data.type === "rate_limit_error" ? rateLimitMessage : undefined);
  return message?.replaceAll("OpenAI", provider === "xai" ? "xAI" : "OpenAI");
}

export function voiceError(error: unknown): VoiceError {
  if (error instanceof VoiceError) return error;
  if (error instanceof XaiError) {
    const body = z.object({ error: z.unknown() }).safeParse(error.body);
    const message = providerErrorMessage(body.success ? body.data.error : undefined, error.code, "xai");
    if (message) return new VoiceError(message, error.status);
    if (error.status === 401 || error.status === 403) return new VoiceError("xAI voice access was denied. Check XAI_API_KEY and voice model access on the server.", 503);
    if (error.status === 429) return new VoiceError("xAI voice reached an account limit. Check xAI credits and usage limits before retrying.", 429);
    return new VoiceError("xAI voice could not connect. Check the voice model and network, then try again.", 502);
  }
  if (error instanceof OpenAiError) {
    const body = z.object({ error: z.unknown() }).safeParse(error.body);
    const message = providerErrorMessage(body.success ? body.data.error : undefined, error.code);
    if (message) return new VoiceError(message, error.status);
    if (error.status === 401 || error.status === 403) return new VoiceError("OpenAI voice access was denied. Check OPENAI_API_KEY and model access on the server.", 503);
    if (error.status === 429) return new VoiceError("OpenAI rejected voice because of an account limit. Check OpenAI billing and usage limits before retrying.", 429);
    return new VoiceError("OpenAI voice could not connect. Check the voice model and network, then try again.", 502);
  }
  return new VoiceError("Voice disconnected. Start voice again to reconnect.", 502);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface VoiceTurn {
  text: string;
  saved: ReturnType<typeof deferred<boolean>>;
  final: boolean;
}

const actionSchema = z.object({ tool: z.string().min(1).max(120), params: z.record(z.string(), z.unknown()) }).strict();
const discoverySchema = z.object({ query: z.string().min(1).max(160) }).strict();
const reviewSchema = z.object({ decision: z.enum(["apply", "cancel", "revise"]), prompt: z.string().max(8000).optional() }).strict();

export class VoiceSession {
  readonly id = randomUUID();
  readonly token = randomBytes(32).toString("hex");
  readonly model: string;
  private provider: ReturnType<typeof createOpenAi>;
  private control: VoiceControl | null = null;
  private callId: string | null = null;
  private negotiation: Promise<OpenAiRealtimeCallResponse> | null = null;
  private abort = new AbortController();
  private stopped = false;
  private closing: Promise<void> | null = null;
  private listener: ((event: VoiceSessionEvent) => void) | null = null;
  private backlog: VoiceSessionEvent[] = [];
  private seen = new Set<string>();
  private captions = new Map<string, VoiceCaption>();
  private turns = new Map<string, VoiceTurn>();
  private currentTurn = "";
  private responseTurns = new Map<string, string>();
  private responseItems = new Map<string, Set<string>>();
  private interruptedResponses = new Set<string>();
  private pendingAssistantHistory = new Map<string, VoiceCaption[]>();
  private activeResponse = false;
  private replyProgress = new VoiceReplyProgress();
  private abandonedResponses = new Set<string>();
  private recoveringTurn: string | null = null;
  private lastAction: { turnId: string; callId: string; outcome: VoiceOutcome } | null = null;
  private needsResponse = false;
  private speaking = false;
  private waitingAction: { callId: string; done: ReturnType<typeof deferred<VoiceOutcome>> } | null = null;
  private reviewCall: string | null = null;
  private toolChain: Promise<void> = Promise.resolve();
  private pendingTools = 0;
  private audioAttached = false;
  private audioClose: (() => void) | undefined;
  private writes: Promise<void> = Promise.resolve();
  private lastActivity = Date.now();
  private startedAt = Date.now();
  private usage = { responses: 0, inputTokens: 0, outputTokens: 0 };
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private books: BookManager,
    readonly bookId: string,
    readonly notebookId: string | undefined,
    private engine: Engine,
    apiKey: string,
    readonly idleTimeoutMs: number,
    private onClose: () => void,
    readonly providerName: VoiceProvider = "openai",
    readonly inputRate: VoiceInputRate = VOICE_PCM_RATE,
  ) {
    this.model = providerName === "xai" ? process.env.VIDEOBOOK_XAI_VOICE_MODEL?.trim() || DEFAULT_XAI_VOICE_MODEL : process.env.VIDEOBOOK_VOICE_MODEL?.trim() || DEFAULT_VOICE_MODEL;
    this.provider = createOpenAi({ apiKey, timeout: 20_000 });
    this.apiKey = apiKey;
    this.timer = setInterval(() => {
      if (!this.scopeAlive()) void this.close("Workspace closed. Start voice in the current project.");
      else if (Date.now() - this.lastActivity > this.idleTimeoutMs) void this.close("Comms idle. Start voice to resume.");
      else if (Date.now() - this.startedAt > 30 * 60_000) void this.close("Comms session ended. Start voice to resume.");
      else {
        try { this.recoverReply(); } catch (error) { this.fail(voiceError(error).message); }
      }
    }, Math.min(1000, idleTimeoutMs));
    this.timer.unref();
  }

  private apiKey: string;

  owns(token: string): boolean {
    const candidate = Buffer.from(token);
    const expected = Buffer.from(this.token);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  private scopeAlive(): boolean {
    const book = this.books.get(this.bookId);
    if (!book.ok || book.value.engine !== this.engine) return false;
    return !this.notebookId || this.engine.notebooks.read(this.notebookId).ok;
  }

  async start(sdp: string, signal: AbortSignal): Promise<VoiceSessionDescriptor> {
    const onAbort = () => { void this.close("Voice start cancelled."); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted || this.stopped) throw new VoiceError("Voice start cancelled.", 499);
      if (this.providerName === "xai") return await this.startXai();
      this.negotiation = this.provider.post.v1.realtime.calls({
        sdp, session: voiceSessionConfig(voiceWorkspaceContext(this.engine, this.notebookId), this.model),
      });
      const call = await this.negotiation;
      this.callId = call.callId;
      if (this.stopped) {
        await this.provider.post.v1.realtime.calls.hangup(call.callId).catch(() => undefined);
        throw new VoiceError("Voice start cancelled.", 499);
      }
      this.control = await connectOpenAiRealtime({
        apiKey: this.apiKey, callId: call.callId, signal: this.abort.signal, timeout: 10_000,
        onEvent: (event) => { try { this.receive(event); } catch { this.fail("Voice could not process an event. Start voice to reconnect."); } },
        onError: (error) => { this.fail(voiceError(error).message); },
        onClose: () => { if (!this.stopped) this.fail("Voice connection lost. Start voice to reconnect."); },
      });
      if (this.stopped) throw new VoiceError("Voice start cancelled.", 499);
      return { id: this.id, token: this.token, provider: "openai", transport: "webrtc", sdp: call.sdp, model: this.model, idleTimeoutMs: this.idleTimeoutMs };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async startXai(): Promise<VoiceSessionDescriptor> {
    const configured = deferred<void>();
    let setupError: Error | undefined;
    const connection = await connectXaiRealtime({
      apiKey: this.apiKey, model: this.model, signal: this.abort.signal, timeout: 10_000,
      onEvent: event => {
        if (event.type === "session.updated") configured.resolve();
        if (event.type === "error") {
          setupError = new XaiError("xAI voice configuration failed", 502, { error: event.error });
          configured.resolve();
        }
        try { this.receive(event); } catch { this.fail("Voice could not process an event. Start voice to reconnect."); }
      },
      onError: error => { setupError = error; configured.resolve(); if (this.control) this.fail(voiceError(error).message); },
      onClose: () => { configured.resolve(); if (!this.stopped) this.fail("xAI voice connection lost. Start voice to reconnect."); },
    });
    this.control = connection;
    if (this.stopped) { connection.close(); throw new VoiceError("Voice start cancelled.", 499); }
    connection.send({ type: "session.update", session: xaiVoiceSessionConfig(voiceWorkspaceContext(this.engine, this.notebookId), this.inputRate) });
    const deadline = setTimeout(() => { setupError = new XaiError("xAI voice setup timed out", 504); configured.resolve(); }, 10_000);
    const aborted = () => configured.resolve();
    this.abort.signal.addEventListener("abort", aborted, { once: true });
    try {
      await configured.promise;
      if (setupError) throw setupError;
      if (this.stopped) throw new VoiceError("Voice start cancelled.", 499);
      return { id: this.id, token: this.token, provider: "xai", transport: "pcm", sampleRate: VOICE_PCM_RATE, model: this.model, idleTimeoutMs: this.idleTimeoutMs };
    } finally { clearTimeout(deadline); this.abort.signal.removeEventListener("abort", aborted); }
  }

  attachAudio(close: () => void): void {
    if (this.stopped || this.providerName !== "xai" || this.audioAttached) throw new VoiceError("Voice audio is unavailable or already connected.", 409);
    this.audioAttached = true;
    this.audioClose = close;
  }

  appendAudio(audio: Buffer): void {
    if (this.stopped || !this.audioAttached || this.providerName !== "xai") throw new VoiceError("Voice audio is closed.", 409);
    if (audio.length === 0 || audio.length > 16_000 || audio.length % 2 !== 0) throw new VoiceError("Invalid voice audio frame.", 400);
    this.control?.send({ type: "input_audio_buffer.append", audio: audio.toString("base64") });
  }

  interruptPlayback(responseId: string, itemId?: string, audioEndMs?: number): void {
    this.interruptTranscript(responseId);
    if (this.stopped || this.providerName !== "xai" || this.abandonedResponses.has(responseId) || !itemId || audioEndMs === undefined || !this.responseItems.get(responseId)?.has(itemId)) return;
    this.control?.send({ type: "conversation.item.truncate", item_id: itemId, content_index: 0, audio_end_ms: audioEndMs });
  }

  subscribe(listener: (event: VoiceSessionEvent) => void): void {
    if (this.listener || this.stopped) throw new VoiceError("Voice session is already connected or closed.", 409);
    this.listener = listener;
    this.backlog.splice(0).forEach(listener);
  }

  private emit(event: VoiceSessionEvent): void {
    if (this.listener) this.listener(event);
    else {
      this.backlog.push(event);
      if (this.backlog.length > 256) this.fail("Voice event connection was not established. Start voice again.");
    }
  }

  private turn(id: string): VoiceTurn {
    let turn = this.turns.get(id);
    if (!turn) {
      turn = { text: "", saved: deferred<boolean>(), final: false };
      this.turns.set(id, turn);
    }
    return turn;
  }

  private save(operation: () => Promise<void>): void {
    this.writes = this.writes.then(async () => {
      if (!this.scopeAlive()) return;
      await operation();
    }).catch(() => { this.fail("Could not save voice history. Voice stopped; your typed draft is safe."); });
  }

  private caption(id: string, role: VoiceCaption["role"], text: string, final: boolean, userTurnId?: string): void {
    if (this.captions.get(id)?.final) return;
    const value: VoiceCaption = { id, role, text: text.slice(0, 16_000), final };
    this.captions.set(id, value);
    this.emit({ type: "caption", caption: value });
    if (!final) return;
    if (role === "assistant" && userTurnId && !this.turn(userTurnId).final) {
      const waiting = this.pendingAssistantHistory.get(userTurnId) ?? [];
      waiting.push(value);
      this.pendingAssistantHistory.set(userTurnId, waiting);
      return;
    }
    const turn = role === "user" ? this.turn(id) : null;
    if (turn) { turn.final = true; turn.text = value.text; }
    this.save(async () => {
      if (turn && value.text.trim()) {
        const result = await this.engine.prompts.record({ surface: "chat", prompt: value.text, context: { source: "voice", sessionId: this.id, turnId: id, model: this.model, notebookId: this.notebookId } });
        if (!result.ok) { turn.saved.resolve(false); throw new Error(result.error.message); }
      }
      await appendVoiceHistory(this.engine, { ...value, sessionId: this.id, notebookId: this.notebookId, model: this.model });
      if (turn) {
        for (const pending of this.pendingAssistantHistory.get(id) ?? []) {
          const latest = this.captions.get(pending.id) ?? pending;
          await appendVoiceHistory(this.engine, { ...latest, text: latest.interrupted ? "" : latest.text, sessionId: this.id, notebookId: this.notebookId, model: this.model });
        }
        this.pendingAssistantHistory.delete(id);
      }
      turn?.saved.resolve(true);
    });
  }

  receive(event: OpenAiRealtimeServerEvent): void {
    if (this.stopped) return;
    if (event.event_id && this.seen.has(event.event_id)) return;
    if (event.event_id) this.seen.add(event.event_id);
    if (this.seen.size > 20_000) { void this.close("Comms session limit reached. Start voice to resume."); return; }
    if (!this.scopeAlive()) { void this.close("Workspace closed."); return; }
    const responseId = event.response_id ?? (typeof event.response?.id === "string" ? event.response.id : undefined);
    if (responseId && this.abandonedResponses.has(responseId) && event.type !== "response.done") return;
    if (responseId) this.replyProgress.progress(responseId, Date.now());
    const id = event.item_id ?? "";
    if (id && event.response_id && (event.type.startsWith("response.output_audio") || event.type.startsWith("response.audio."))) {
      const items = this.responseItems.get(event.response_id) ?? new Set<string>();
      items.add(id);
      this.responseItems.set(event.response_id, items);
      if (this.interruptedResponses.has(event.response_id)) return;
    }
    if (event.type === "input_audio_buffer.speech_started") {
      this.lastActivity = Date.now();
      this.currentTurn = id;
      this.replyProgress.beginTurn();
      this.recoveringTurn = null;
      this.turn(id);
      this.caption(id, "user", "", false);
      this.speaking = true;
      this.needsResponse = false;
      this.emit({ type: "activity", phase: "listening", interrupt: this.providerName === "xai" });
    } else if (event.type === "input_audio_buffer.speech_stopped") {
      this.speaking = false;
      this.lastActivity = Date.now();
      this.replyProgress.expect(this.lastActivity);
      this.emit({ type: "activity", phase: "thinking" });
    } else if (event.type === "conversation.item.input_audio_transcription.delta") {
      this.caption(id, "user", (this.captions.get(id)?.text ?? "") + (event.delta ?? ""), false);
    } else if (event.type === "conversation.item.input_audio_transcription.updated") {
      this.caption(id, "user", event.transcript ?? "", false);
    } else if (event.type === "conversation.item.input_audio_transcription.completed") {
      this.caption(id, "user", event.transcript ?? "", true);
    } else if (event.type === "conversation.item.input_audio_transcription.failed") {
      this.fail(providerErrorMessage(event.error, undefined, this.providerName) ?? "Could not transcribe this turn. Start voice and try again.");
    } else if (this.providerName === "xai" && (event.type === "response.output_audio.delta" || event.type === "response.audio.delta")) {
      if (event.response_id && event.item_id && event.delta && !this.interruptedResponses.has(event.response_id)) {
        this.emit({ type: "audio", audio: event.delta, responseId: event.response_id, itemId: event.item_id });
      }
    } else if (this.providerName === "xai" && (event.type === "response.output_audio.done" || event.type === "response.audio.done")) {
      if (event.response_id) this.emit({ type: "audio-done", responseId: event.response_id });
    } else if (event.type === "response.output_audio_transcript.delta") {
      this.caption(id, "assistant", (this.captions.get(id)?.text ?? "") + (event.delta ?? ""), false);
    } else if (event.type === "response.output_audio_transcript.done") {
      this.caption(id, "assistant", event.transcript ?? this.captions.get(id)?.text ?? "", true, event.response_id ? this.responseTurns.get(event.response_id) : undefined);
    } else if (event.type === "conversation.item.truncated") {
      const caption = this.captions.get(id);
      if (caption && !caption.interrupted) {
        const interrupted = { ...caption, final: true, interrupted: true };
        this.captions.set(id, interrupted);
        this.emit({ type: "caption", caption: interrupted });
        this.save(() => appendVoiceHistory(this.engine, { ...interrupted, text: "", sessionId: this.id, notebookId: this.notebookId, model: this.model }));
      }
    } else if (event.type === "response.created") {
      this.activeResponse = true;
      if (responseId) {
        this.responseTurns.set(responseId, this.currentTurn);
        this.replyProgress.started(responseId, Date.now());
      }
    } else if (event.type === "response.done") {
      const completion = this.replyProgress.finished(responseId, Date.now());
      const usage = event.response?.usage as Record<string, unknown> | undefined;
      this.usage.responses += 1;
      this.usage.inputTokens += typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
      this.usage.outputTokens += typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
      if (completion === "stale") return;
      this.activeResponse = false;
      if (completion === "retry") this.needsResponse = true;
      if (event.response?.status === "failed") {
        const details = z.object({ error: z.unknown().optional() }).safeParse(event.response.status_details);
        this.fail(providerErrorMessage(details.success ? details.data.error : undefined, undefined, this.providerName) ?? "The voice reply failed. Start voice to retry.");
      }
      else this.continueResponse();
    } else if (event.type === "response.function_call_arguments.done" && event.call_id) {
      const key = `call:${event.call_id}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      const turnId = (event.response_id && this.responseTurns.get(event.response_id)) || this.currentTurn;
      this.pendingTools += 1;
      this.toolChain = this.toolChain.then(() => this.runTool(event, turnId)).catch(() => { this.fail("Voice action failed. Check the command and try again."); }).finally(() => { this.pendingTools -= 1; this.continueResponse(); });
    } else if (event.type === "error") {
      if (event.error?.code === "response_cancel_not_active") {
        if (this.replyProgress.cancelled(Date.now())) {
          this.activeResponse = false;
          this.needsResponse = true;
          this.continueResponse();
        }
        return;
      }
      this.fail(providerErrorMessage(event.error, undefined, this.providerName) ?? "Voice service reported an error. Start voice again; check model access if it repeats.");
    }
  }

  private continueResponse(): void {
    if (!this.needsResponse || this.activeResponse || this.pendingTools > 0 || this.speaking || this.stopped) return;
    this.needsResponse = false;
    this.activeResponse = true;
    this.replyProgress.expect(Date.now());
    this.control?.send({ type: "response.create" });
  }

  private recoverReply(): void {
    if (this.stopped || !this.control || !this.currentTurn || this.speaking || this.pendingTools > 0) return;
    const recovery = this.replyProgress.check(Date.now());
    if (!recovery) return;
    if (recovery.type === "failed") {
      this.fail("The voice service stopped responding. Start voice to try again.");
      return;
    }
    this.emit({ type: "activity", phase: "thinking", interrupt: this.providerName === "xai" });
    this.recoveringTurn = this.currentTurn;
    if (recovery.responseId) {
      this.abandonedResponses.add(recovery.responseId);
      this.interruptTranscript(recovery.responseId);
      this.control.send({ type: "response.cancel", response_id: recovery.responseId });
      return;
    }
    this.activeResponse = false;
    this.needsResponse = true;
    this.continueResponse();
  }

  private output(callId: string, result: unknown, turnId: string): void {
    if (this.stopped) return;
    const serialized = JSON.stringify(result);
    const output = serialized.length <= 40_000 ? serialized : JSON.stringify({ truncated: true, resultText: serialized.slice(0, 36_000) });
    this.control?.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
    if (turnId === this.currentTurn) { this.needsResponse = true; this.continueResponse(); }
  }

  private async runTool(event: OpenAiRealtimeServerEvent, turnId: string): Promise<void> {
    const callId = event.call_id!;
    if (this.stopped || turnId !== this.currentTurn) return;
    try {
      if (!this.control || !turnId) throw new Error("Wait for a spoken user request.");
      const args: unknown = JSON.parse(event.arguments ?? "{}");
      if (event.name === "find_workspace_actions") {
        const { query } = discoverySchema.parse(args);
        this.output(callId, { actions: discoverVoiceActions(this.engine, query), workspace: voiceWorkspaceContext(this.engine, this.notebookId) }, turnId);
        return;
      }
      if (event.name === "resolve_pending_review") {
        this.output(callId, await this.resolveReview(callId, reviewSchema.parse(args)), turnId);
        return;
      }
      if (event.name !== "prepare_workspace_action") throw new Error("Unknown voice action.");
      if (this.recoveringTurn === turnId && this.lastAction?.turnId === turnId) {
        this.output(callId, this.lastAction.outcome, turnId);
        return;
      }
      if (this.reviewCall || this.waitingAction) throw new Error("A review is already on screen. Use resolve_pending_review to apply, cancel, or revise it before requesting another workspace action.");
      const turn = this.turn(turnId);
      const timeout = setTimeout(() => turn.saved.resolve(false), 10_000);
      const saved = await turn.saved.promise.finally(() => clearTimeout(timeout));
      if (!saved || !turn.text.trim()) throw new Error("The user transcript could not be saved. Ask the user to repeat the request.");
      if (this.stopped || turnId !== this.currentTurn || !this.scopeAlive()) return;
      const decision = actionSchema.parse(args);
      if (decision.params.book_id !== undefined && decision.params.book_id !== this.bookId) throw new Error("Voice actions must stay in the current project.");
      if (decision.params.notebook_id !== undefined && decision.params.notebook_id !== this.notebookId) throw new Error("Voice actions must stay in the current notebook.");
      const result = await withBookContext({ bookId: this.bookId, engine: this.engine }, () => prepareVoiceChatAction(
        this.engine, { book_id: this.bookId, notebook_id: this.notebookId, prompt: turn.text }, { ...decision, message: turn.text },
      ));
      if (this.stopped || turnId !== this.currentTurn) return;
      const raw = result.content[0]?.text ?? "null";
      if (result.isError) { this.output(callId, { status: "failed", message: raw }, turnId); return; }
      const value: unknown = JSON.parse(raw);
      const plan = chatActionPlanSchema.safeParse(value);
      if (!plan.success) { this.output(callId, { status: "completed", result: value }, turnId); return; }
      const done = deferred<VoiceOutcome>();
      this.waitingAction = { callId, done };
      this.emit({ type: "action", callId, prompt: turn.text, plan: plan.data });
      const deadline = setTimeout(() => done.resolve({ status: "failed", message: "The command UI did not acknowledge this action. Check its current status before retrying." }), 60_000);
      const outcome = await done.promise.finally(() => clearTimeout(deadline));
      this.lastAction = { turnId, callId, outcome };
      if (this.waitingAction?.callId === callId) this.waitingAction = null;
      if (outcome.status === "review") this.reviewCall = callId;
      this.output(callId, outcome, turnId);
    } catch (error) {
      this.output(callId, { status: "failed", message: error instanceof z.ZodError ? "Invalid action parameters. Use the discovered schema." : error instanceof Error ? error.message : "The voice action failed." }, turnId);
    }
  }

  /**
   * Hand a spoken decision about the on-screen review to the command UI and
   * wait for what actually happened. The review stays open on a revise, so the
   * speaker can keep changing it before spending anything.
   */
  private async resolveReview(callId: string, command: VoiceReviewCommand): Promise<VoiceOutcome> {
    if (!this.reviewCall) throw new Error("There is no review on screen to act on.");
    if (this.waitingAction) throw new Error("The command UI is still working on the last spoken decision.");
    if (command.decision === "revise" && !command.prompt?.trim()) throw new Error("Revise needs the whole replacement prompt.");
    const done = deferred<VoiceOutcome>();
    this.waitingAction = { callId, done };
    this.emit({ type: "review", callId, command });
    const deadline = setTimeout(() => done.resolve({ status: "failed", message: "The command UI did not act on that. Check the review on screen." }), 60_000);
    const outcome = await done.promise.finally(() => clearTimeout(deadline));
    if (this.waitingAction?.callId === callId) this.waitingAction = null;
    if (outcome.status !== "review") this.reviewCall = null;
    return outcome;
  }

  acknowledge(callId: string, outcome: VoiceOutcome): void {
    if (this.stopped) throw new VoiceError("Voice session is closed.", 410);
    this.lastActivity = Date.now();
    if (this.waitingAction?.callId === callId) {
      if (outcome.status === "review") this.reviewCall = callId;
      this.waitingAction.done.resolve(outcome);
      return;
    }
    if (this.reviewCall !== callId) throw new VoiceError("This voice action is no longer pending.", 409);
    if (outcome.status !== "review") this.reviewCall = null;
    if (this.lastAction?.callId === callId) this.lastAction.outcome = outcome;
    // A spoken decision reports this outcome and then returns it as the tool
    // result. Telling the model twice would make it answer twice.
    if (this.waitingAction) return;
    this.contextMessage({ applicationOutcome: outcome });
  }

  interruptTranscript(responseId: string): void {
    if (this.stopped) return;
    this.interruptedResponses.add(responseId);
    for (const id of this.responseItems.get(responseId) ?? []) {
      const caption = this.captions.get(id);
      if (!caption || caption.interrupted) continue;
      const interrupted = { ...caption, final: true, interrupted: true };
      this.captions.set(id, interrupted);
      this.emit({ type: "caption", caption: interrupted });
      this.save(() => appendVoiceHistory(this.engine, { ...interrupted, text: "", sessionId: this.id, notebookId: this.notebookId, model: this.model }));
    }
  }

  contextMessage(value: { applicationOutcome?: VoiceOutcome; userText?: string; assistantText?: string }): void {
    if (this.stopped) return;
    this.control?.send({ type: "conversation.item.create", item: { type: "message", role: this.providerName === "xai" ? "user" : "system", content: [{ type: "input_text", text: `Application update (data): ${JSON.stringify(value)}` }] } });
    if (value.applicationOutcome) {
      this.needsResponse = true;
      this.continueResponse();
    }
  }

  private fail(message: string): void {
    if (this.stopped) return;
    if (this.listener) this.listener({ type: "error", message });
    void this.close(message);
  }

  close(reason = "Comms off."): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    clearInterval(this.timer);
    this.abort.abort();
    this.control?.close();
    this.audioClose?.();
    this.audioClose = undefined;
    for (const turn of this.turns.values()) turn.saved.resolve(false);
    this.waitingAction?.done.resolve({ status: "failed", message: "Voice stopped. Check the command UI for accepted actions." });
    this.listener?.({ type: "closed", reason });
    this.listener = null;
    this.backlog = [];
    this.closing = (async () => {
      const negotiated = await this.negotiation?.catch(() => null);
      this.callId ??= negotiated?.callId ?? null;
      if (this.callId) await this.provider.post.v1.realtime.calls.hangup(this.callId).catch(() => undefined);
      await this.writes;
      if (this.scopeAlive()) await appendDiagnostic(this.engine, "voice-session-closed", { operationId: this.id, bookId: this.bookId, notebookId: this.notebookId, provider: this.providerName, voiceModel: this.model, count: this.usage.responses, inputTokens: this.usage.inputTokens, outputTokens: this.usage.outputTokens, durationMs: Date.now() - this.startedAt }).catch(() => undefined);
      this.apiKey = "";
    })().finally(this.onClose);
    return this.closing;
  }
}

export class VoiceSessions {
  private sessions = new Map<string, VoiceSession>();
  private closed = false;
  constructor(private books: BookManager) {}

  async start(input: { bookId: string; notebookId?: string; sdp?: string; mode?: VoiceMode; sampleRate?: VoiceInputRate }, signal: AbortSignal): Promise<VoiceSessionDescriptor> {
    if (this.closed) throw new VoiceError("Voice service is shutting down.", 503);
    if (this.sessions.size >= 4) throw new VoiceError("Four voice sessions are already active. Stop another session first.", 429);
    const book = this.books.get(input.bookId);
    if (!book.ok) throw new VoiceError("Open an available project before starting voice.", 404);
    if (input.notebookId && !book.value.engine.notebooks.read(input.notebookId).ok) throw new VoiceError("This notebook is no longer available.", 404);
    const configured = Number(process.env.VIDEOBOOK_VOICE_IDLE_TIMEOUT_MS ?? 120_000);
    const idle = Number.isFinite(configured) ? Math.min(600_000, Math.max(10_000, configured)) : 120_000;
    const attempt = async (provider: VoiceProvider) => {
      if (signal.aborted || this.closed) throw new VoiceError("Voice start cancelled.", 499);
      if (this.sessions.size >= 4) throw new VoiceError("Four voice sessions are already active. Stop another session first.", 429);
      const keyName = provider === "xai" ? "XAI_API_KEY" : "OPENAI_API_KEY";
      const apiKey = getApiKey(keyName);
      if (!apiKey) throw new VoiceError(`Voice needs ${keyName} on the server. Configure it, then start voice again.`, 503);
      const session = new VoiceSession(this.books, input.bookId, input.notebookId, book.value.engine, apiKey, idle, () => this.sessions.delete(session.id), provider, input.sampleRate);
      this.sessions.set(session.id, session);
      try { return await session.start(input.sdp ?? "", signal); }
      catch (error) { await session.close(); throw voiceError(error); }
    };
    if (input.mode !== "auto") return await attempt(input.mode ?? "openai");
    try { return await attempt("openai"); }
    catch (error) {
      const first = voiceError(error);
      if (signal.aborted || this.closed || !(first.status >= 500 || [401, 403, 404, 408, 429].includes(first.status))) throw first;
      try { return { ...await attempt("xai"), fallbackReason: first.message }; }
      catch (failure) {
        const last = voiceError(failure);
        if (signal.aborted || this.closed) throw last;
        throw new VoiceError(`OpenAI: ${first.message} xAI: ${last.message}`, last.status);
      }
    }
  }

  get(id: string, token: string): VoiceSession {
    const session = this.sessions.get(id);
    if (!session || !session.owns(token)) throw new VoiceError("Voice session was not found. Start voice again.", 404);
    return session;
  }

  async stop(id: string, token: string, interruptedResponseId?: string | null): Promise<void> {
    if (!this.sessions.has(id)) return;
    const session = this.get(id, token);
    if (interruptedResponseId) session.interruptTranscript(interruptedResponseId);
    await session.close();
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map((session) => session.close("Server is shutting down.")));
  }
}
