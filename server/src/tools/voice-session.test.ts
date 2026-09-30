import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import express from "express";
import { OpenAiError } from "@apicity/openai";
import { XaiError } from "@apicity/xai";
import { OpenAiRealtimeCallRequestSchema } from "@apicity/openai/zod";
import { BookManager } from "../book-manager.js";
import { VoiceSession, VoiceSessions, voiceError } from "../voice-session.js";
import {
  isVoiceTurnContinuation,
  joinVoiceTranscripts,
} from "../voice-continuation.js";
import { voiceRouter } from "../voice-http.js";
import { attachVoiceAudio } from "../voice-audio.js";
import { restrictHttpAccess } from "../http-access.js";
import { VOICE_ACTIVATION_PHRASE, VOICE_PCM_RATE, openAiVoiceActivationEvent, voiceSessionConfig, xaiVoiceSessionConfig } from "../voice-config.js";
import { XaiRealtimeEndpoint, sendActivationResponse } from "./xai-realtime-endpoint.js";
import type { Engine } from "videobook-engine";
import { appendVoiceHistory } from "./chat-history.js";
import { voiceWorkspaceContext } from "../voice-actions.js";
import { VoiceReplyProgress } from "../voice-reply-progress.js";
import type { VoiceSessionEvent } from "../voice-contract.js";

describe("voice turn continuation", () => {
  it("joins later clauses onto the original request", () => {
    expect(isVoiceTurnContinuation("generate an image", "of a kitten")).toBe(true);
    expect(isVoiceTurnContinuation("of a kitten", "on a train from C1")).toBe(true);
    expect(joinVoiceTranscripts("generate an image", "of a kitten")).toBe("generate an image of a kitten");
    expect(joinVoiceTranscripts("generate an image of a kitten", "on a train from C1"))
      .toBe("generate an image of a kitten on a train from C1");
  });

  it("treats a later independent request as new rather than a continuation", () => {
    expect(isVoiceTurnContinuation("generate an image", "what's on the board")).toBe(false);
    expect(isVoiceTurnContinuation("generate an image", "list my assets")).toBe(false);
    expect(isVoiceTurnContinuation("generate an image", "hello?")).toBe(false);
    expect(isVoiceTurnContinuation("generate an image", "cancel that")).toBe(false);
    expect(isVoiceTurnContinuation("generate an image", "now generate a video")).toBe(false);
  });
});

describe("voice reply progress", () => {
  it("retries a missing response once and bounds the second wait", () => {
    const progress = new VoiceReplyProgress();
    progress.beginTurn();
    progress.expect(0);
    expect(progress.check(14_999)).toBeNull();
    expect(progress.check(15_000)).toEqual({ type: "retry", responseId: null });
    expect(progress.check(29_999)).toBeNull();
    expect(progress.check(30_000)).toEqual({ type: "failed" });
    expect(progress.check(60_000)).toBeNull();
  });

  it("recovers a stalled partial reply only after cancellation and ignores late response events", () => {
    const progress = new VoiceReplyProgress();
    progress.beginTurn();
    progress.started("stalled", 0);
    progress.expect(10);
    progress.progress("stalled", 500);
    expect(progress.check(15_000)).toBeNull();
    expect(progress.check(15_500)).toEqual({ type: "retry", responseId: "stalled" });
    progress.progress("stalled", 16_000);
    expect(progress.finished("older", 16_100)).toBe("stale");
    expect(progress.finished("stalled", 16_200)).toBe("retry");
    progress.started("replacement", 16_300);
    expect(progress.finished("stalled", 16_400)).toBe("stale");
    progress.progress("stalled", 30_000);
    expect(progress.check(31_300)).toEqual({ type: "failed" });
    progress.beginTurn();
    progress.expect(32_000);
    expect(progress.check(47_000)).toEqual({ type: "retry", responseId: null });
  });

  it("bounds cancellation acknowledgement and tolerates a response already cancelled by the provider", () => {
    for (const acknowledged of [true, false]) {
      const progress = new VoiceReplyProgress();
      progress.started("stalled", 0);
      expect(progress.check(15_000)).toEqual({ type: "retry", responseId: "stalled" });
      if (acknowledged) {
        expect(progress.cancelled(16_000)).toBe(true);
        expect(progress.cancelled(16_001)).toBe(false);
        expect(progress.check(20_000)).toBeNull();
      } else {
        progress.progress("stalled", 19_000);
        expect(progress.check(20_000)).toEqual({ type: "failed" });
      }
    }
  });

  it("keeps streaming replies alive, finishes tool rounds, and clears recovery on a new spoken turn", () => {
    const progress = new VoiceReplyProgress();
    progress.started("streaming", 0);
    for (const now of [10_000, 20_000, 30_000]) {
      progress.progress("streaming", now);
      expect(progress.check(now + 1000)).toBeNull();
    }
    expect(progress.finished("streaming", 31_000)).toBe("done");
    expect(progress.check(60_000)).toBeNull();
    progress.expect(61_000);
    progress.beginTurn();
    expect(progress.check(90_000)).toBeNull();
    progress.started("next", 91_000);
    expect(progress.finished("streaming", 91_100)).toBe("stale");
    expect(progress.finished("next", 91_200)).toBe("done");
  });
});

describe("voice session boundaries", () => {
  let root: string;
  let books: BookManager;
  let engine: Engine;
  let bookId: string;
  let notebookId: string;
  let sessions: VoiceSessions;
  const server = createServer();
  let origin: string;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalXaiKey = process.env.XAI_API_KEY;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-voice-session-"));
    books = new BookManager({ libraryDir: join(root, "books"), objectPrefix: "test-objects" });
    await books.ready();
    const created = await books.create("voice-session");
    if (!created.ok) throw new Error(created.error.message);
    bookId = created.value.bookId;
    const managed = books.get(bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    engine = managed.value.engine;
    notebookId = engine.notebooks.list()[0]!.id;
    sessions = new VoiceSessions(books);
    const app = express();
    app.use(restrictHttpAccess);
    app.use("/api/voice", voiceRouter(sessions));
    server.on("request", app);
    attachVoiceAudio(server, sessions);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");
    origin = `http://127.0.0.1:${address.port}`;
    delete process.env.OPENAI_API_KEY;
    delete process.env.XAI_API_KEY;
  });

  afterAll(async () => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalXaiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalXaiKey;
    await sessions?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await books?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("validates the native audio model, lowest reasoning and interruption configuration against the provider", () => {
    const request = OpenAiRealtimeCallRequestSchema.parse({ sdp: "v=0\r\n", session: voiceSessionConfig({ book: "voice-session" }) });
    expect(request.session).toMatchObject({ model: "gpt-realtime-2.1", reasoning: { effort: "minimal" }, audio: { input: { turn_detection: { interrupt_response: true, silence_duration_ms: 350 } } } });
    expect(request.session?.tools?.map(tool => "name" in tool ? tool.name : "")).toEqual(["find_workspace_actions", "prepare_workspace_action", "resolve_pending_review"]);
  });

  it("offers the on-screen review the three decisions a speaker can make about it", () => {
    const session = voiceSessionConfig({ book: "voice-session" });
    const review = session.tools?.find(tool => "name" in tool && tool.name === "resolve_pending_review");
    expect(review).toMatchObject({
      parameters: {
        properties: {
          decision: { enum: ["apply", "cancel", "revise"] },
          prompt: { type: "string" },
          model: { type: "string" },
          settings: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
        },
        required: ["decision"],
        additionalProperties: false,
      },
    });
    // A setting written into the prompt reads fine and changes nothing, so the
    // instructions have to separate the two explicitly.
    expect(session.instructions).toContain("resolve_pending_review is the only action available");
    expect(session.instructions).toMatch(/put those in settings, never in prompt text/u);
    // Applying spends money, so the instructions have to say both that voice
    // can do it and that ambiguous speech is not approval.
    expect(session.instructions).toMatch(/Apply or cancel only on a clear instruction/u);
    expect(session.instructions).toMatch(/Applying spends money/u);
  });

  it("speaks as one terse character and fills optional parameters in itself", () => {
    const context = { book: "voice-session" };
    const session = voiceSessionConfig(context);
    expect(session.audio?.output?.voice).toBe("alloy");
    expect(session.audio?.output?.speed).toBe(1);
    expect(xaiVoiceSessionConfig(context, VOICE_PCM_RATE).voice).toBe("sal");
    // The model read an optional staleness guard as a precondition and asked
    // the speaker to recite a revision hash the cell details never display.
    expect(session.instructions).toMatch(/Never ask the user for a parameter the discovered schema marks optional/u);
    expect(session.instructions).toMatch(/expected_revision in particular is an optional staleness guard, never a precondition/u);
    expect(session.instructions).toMatch(/Never apologize/u);
    expect(session.instructions).toMatch(/Never joke or add an aside/u);
    expect(session.instructions).toMatch(/'Affirmative\.' 'Negative\.' 'Complete\.' 'Standing by\.'/u);
    expect(session.instructions).toMatch(/'Unable to comply\. <reason>\.' 'Specify <detail>\.'/u);
    expect(session.instructions).toMatch(/When the user asks for longer output \(a count, a list, a read-back\), give all of it/u);
    // Both providers have to be the same character, not two personalities.
    expect(xaiVoiceSessionConfig(context, VOICE_PCM_RATE).instructions).toBe(session.instructions);
  });

  it("rejects hostile origins and bounded malformed offers before provider access", async () => {
    const hostile = await fetch(`${origin}/api/voice`, { method: "POST", headers: { Origin: "https://untrusted.example" } });
    expect(hostile.status).toBe(403);
    const malformed = await fetch(`${origin}/api/voice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId, notebookId, sdp: "invalid" }) });
    expect(malformed.status).toBe(400);
    const oversized = await fetch(`${origin}/api/voice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId, notebookId, sdp: "v=0" + "x".repeat(90_000) }) });
    expect(oversized.status).toBe(413);
  });

  it("returns an actionable missing-key error and does not expose session controls", async () => {
    const response = await fetch(`${origin}/api/voice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId, notebookId, sdp: "v=0\r\ns=voice-session\r\n" }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("OPENAI_API_KEY") });
    expect((await fetch(`${origin}/api/voice/unknown/events`)).status).toBe(404);
    expect((await fetch(`${origin}/api/voice/unknown`, { method: "DELETE" })).status).toBe(204);
  });

  it("rejects hostile audio upgrades and credentials in audio URLs", async () => {
    for (const request of [{ path: "", headers: { Origin: "https://untrusted.example" } }, { path: "", headers: { Host: "untrusted.example" } }, { path: "?token=never-in-url", headers: { Origin: origin } }]) {
      const status = await new Promise<number>(resolve => {
        const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/voice/${bookId}/audio${request.path}`, { headers: request.headers });
        socket.on("error", () => undefined);
        socket.once("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode ?? 0); });
        socket.once("open", () => { socket.close(); resolve(101); });
      });
      expect(status).toBe(403);
    }
  });

  it("requires bounded authentication before accepting PCM frames", async () => {
    for (const payload of [Buffer.alloc(20), "invalid", JSON.stringify({ type: "authenticate", token: "x".repeat(64) }), Buffer.alloc(16_002)]) {
      const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/voice/${bookId}/audio`, { origin });
      const closed = once(socket, "close");
      await once(socket, "open");
      socket.send(payload);
      const [code] = await closed;
      expect(code).toBe(Buffer.isBuffer(payload) && payload.length > 16_000 ? 1009 : 1008);
    }
  });

  it("pins explicit providers and reports both failures only in Auto mode", async () => {
    for (const mode of ["openai", "xai", "auto"]) {
      const response = await fetch(`${origin}/api/voice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId, notebookId, mode, sampleRate: 48000, ...(mode === "xai" ? {} : { sdp: "v=0\r\ns=voice-session\r\n" }) }) });
      expect(response.status).toBe(503);
      const failure = await response.json() as { error: string };
      if (mode !== "xai") expect(failure.error).toContain("OPENAI_API_KEY");
      if (mode !== "openai") expect(failure.error).toContain("XAI_API_KEY");
      if (mode === "openai") expect(failure.error).not.toContain("XAI_API_KEY");
      if (mode === "xai") expect(failure.error).not.toContain("OPENAI_API_KEY");
    }
    await expect(sessions.start({ bookId, notebookId, mode: "auto" }, AbortSignal.abort())).rejects.toMatchObject({ status: 499 });
  });

  it("rejects unsupported providers and capture rates before opening a channel", async () => {
    for (const input of [{ mode: "other", sampleRate: 48000 }, { mode: "xai", sampleRate: 12345 }, { mode: "auto", sampleRate: 48000 }]) {
      const response = await fetch(`${origin}/api/voice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId, notebookId, ...input }) });
      expect(response.status).toBe(400);
    }
    expect(voiceError(new XaiError("Private details", 401)).message).toContain("XAI_API_KEY");
    expect(voiceError(new XaiError("Private details", 429, { error: { code: "credit_balance_exhausted" } })).message).toContain("xAI API credits");
  });

  it("limits PCM to one owned channel and discards interrupted xAI audio", async () => {
    const session = new VoiceSession(books, bookId, notebookId, engine, "unused-without-start", 120_000, () => undefined, "xai", 48000);
    const events: VoiceSessionEvent[] = [];
    let audioClosed = 0;
    session.subscribe(event => events.push(event));
    session.attachAudio(() => { audioClosed += 1; });
    expect(() => session.attachAudio(() => undefined)).toThrow("already connected");
    expect(() => session.appendAudio(Buffer.alloc(3))).toThrow("Invalid voice audio");
    expect(() => session.appendAudio(Buffer.alloc(16_002))).toThrow("Invalid voice audio");
    session.receive({ type: "response.output_audio.delta", response_id: "pcm-response", item_id: "pcm-item", event_id: "audio-first", delta: "AAAAAA==" });
    session.interruptPlayback("pcm-response", "pcm-item", 0);
    session.receive({ type: "response.output_audio.delta", response_id: "pcm-response", item_id: "pcm-item", event_id: "audio-late", delta: "AAAAAA==" });
    expect(events.filter(event => event.type === "audio")).toHaveLength(1);
    await session.close();
    await session.close();
    expect(audioClosed).toBe(1);
    expect(() => session.appendAudio(Buffer.alloc(20))).toThrow("closed");
    expect(engine.logs.read("voice-session-closed").find(entry => entry.operationId === session.id)).toMatchObject({ provider: "xai", voiceModel: "grok-voice-think-fast-2.0" });
  });

  it.each([
    ["credit_balance_exhausted", "Add credits in OpenAI billing"],
    ["organization_spend_limit_exceeded", "organization spend limit"],
    ["project_spend_limit_exceeded", "project spend limit"],
    ["organization_usage_limit_exceeded", "organization usage limit"],
    ["insufficient_quota", "Check credits and usage limits"],
  ])("gives actionable recovery for %s without treating it as temporary throttling", (code, recovery) => {
    const failure = voiceError(new OpenAiError("Private provider details", 429, { error: { code, type: "insufficient_quota", message: "Private provider details" } }));
    expect(failure.status).toBe(429);
    expect(failure.message).toContain(recovery);
    expect(failure.message).not.toMatch(/wait|temporar|Private provider details/iu);
    expect(voiceError(failure)).toBe(failure);
  });

  it("separates temporary throttling, quota types and unclassified 429 responses", () => {
    for (const code of ["rate_limit_exceeded", "slow_down"]) {
      expect(voiceError(new OpenAiError("Private details", 429, { error: { code, type: "rate_limit_error" } })).message).toContain("temporarily rate limiting");
    }
    expect(voiceError(new OpenAiError("Private details", 429, { error: { type: "insufficient_quota" } })).message).toContain("Check credits");
    expect(voiceError(new OpenAiError("Private details", 429, { error: { code: "unknown_code", type: "rate_limit_error" } })).message).toContain("temporarily rate limiting");
    expect(voiceError(new OpenAiError("Private details", 429, null, "credit_balance_exhausted")).message).toContain("Add credits");
    for (const body of [null, "Private details", { error: null }, { error: { code: "unknown_code" } }]) {
      const failure = voiceError(new OpenAiError("Private details", 429, body));
      expect(failure.status).toBe(429);
      expect(failure.message).toContain("Check OpenAI billing and usage limits");
      expect(failure.message).not.toMatch(/wait|temporar|Private details/iu);
    }
  });

  it.each(["error", "response.done", "conversation.item.input_audio_transcription.failed"])("stops voice with billing guidance when credits run out during %s", async (type) => {
    const session = new VoiceSession(books, bookId, notebookId, engine, "unused-without-start", 120_000, () => undefined);
    const events: VoiceSessionEvent[] = [];
    session.subscribe(event => events.push(event));
    const error = { code: "credit_balance_exhausted", type: "insufficient_quota", message: "Private provider details" };
    session.receive({ type, error, response: { status: "failed", status_details: { type: "failed", error } } });
    await session.close();
    expect(events.filter(event => event.type === "error")).toEqual([{ type: "error", message: "OpenAI API credits are exhausted. Add credits in OpenAI billing, then start voice again." }]);
    expect(events.filter(event => event.type === "closed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("Private provider details");
    await expect(session.start("v=0", new AbortController().signal)).rejects.toThrow("cancelled");
  });

  it("owns each session token, fences aborted starts and closes exactly once", async () => {
    let closed = 0;
    const session = new VoiceSession(books, bookId, notebookId, engine, "unused-without-start", 120_000, () => { closed += 1; });
    const events: VoiceSessionEvent[] = [];
    session.subscribe(event => events.push(event));
    expect(session.owns(session.token)).toBe(true);
    expect(session.owns("x".repeat(64))).toBe(false);
    expect(session.owns("")).toBe(false);
    expect(() => session.subscribe(() => undefined)).toThrow("already connected");
    await expect(session.start("v=0", AbortSignal.abort())).rejects.toThrow("cancelled");
    await Promise.all([session.close(), session.close()]);
    expect(closed).toBe(1);
    expect(events.filter(event => event.type === "closed")).toHaveLength(1);
    expect(() => session.acknowledge("foreign-call", { status: "completed", message: "Done" })).toThrow("closed");
    expect(engine.logs.read("voice-session-closed")).toEqual(expect.arrayContaining([expect.objectContaining({ operationId: session.id, inputTokens: 0, outputTokens: 0 })]));
  });

  it("omits unheard interrupted speech from the next conversation context", async () => {
    const entry = { id: "assistant-item", role: "assistant" as const, final: true, sessionId: "past-session", notebookId, model: "gpt-realtime-2.1-mini" };
    await appendVoiceHistory(engine, { ...entry, text: "A reply that was interrupted before it finished." });
    await appendVoiceHistory(engine, { ...entry, text: "", interrupted: true });
    await appendVoiceHistory(engine, { ...entry, id: "next-item", text: "I heard the new request." });
    expect(voiceWorkspaceContext(engine, notebookId).recentConversation).toEqual([{ role: "assistant", text: "I heard the new request." }]);
  });

  it("expires idle sessions without restarting their transport", async () => {
    const events: VoiceSessionEvent[] = [];
    const session = new VoiceSession(books, bookId, notebookId, engine, "unused-without-start", 30, () => undefined);
    session.subscribe(event => events.push(event));
    await expect.poll(() => events.some(event => event.type === "closed" && event.reason.includes("idle")), { timeout: 1000 }).toBe(true);
    await session.close();
    expect(events.filter(event => event.type === "closed")).toHaveLength(1);
    await expect(session.start("v=0", new AbortController().signal)).rejects.toThrow("cancelled");
  });

  it("amends interrupted assistant history once and rejects late transcript completion", async () => {
    const session = new VoiceSession(books, bookId, notebookId, engine, "unused-without-start", 120_000, () => undefined);
    const events: VoiceSessionEvent[] = [];
    session.subscribe(event => events.push(event));
    const responseId = `response-${session.id}`;
    session.receive({ type: "response.output_audio_transcript.done", response_id: responseId, item_id: "spoken-item", transcript: "Unheard ending of the answer", event_id: "answer" });
    session.interruptTranscript(responseId);
    session.interruptTranscript(responseId);
    session.receive({ type: "response.output_audio_transcript.done", response_id: responseId, item_id: "spoken-item", transcript: "Late completion", event_id: "late-answer" });
    await session.close();
    const history = engine.logs.read("voice-chat").filter(entry => entry.sessionId === session.id);
    expect(history).toHaveLength(2);
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ text: "", interrupted: true })]));
    expect(events.filter(event => event.type === "caption" && event.caption.interrupted)).toHaveLength(1);
    expect(JSON.stringify(voiceWorkspaceContext(engine, notebookId).recentConversation)).not.toMatch(/Unheard ending|Late completion/u);
  });

  it("persists finalized turns exactly once and ignores events after stop", async () => {
    const session = new VoiceSession(books, bookId, notebookId, engine, "unused-without-start", 120_000, () => undefined);
    const events: VoiceSessionEvent[] = [];
    session.subscribe(event => events.push(event));
    const itemId = `user-${session.id}`;
    session.receive({ type: "input_audio_buffer.speech_started", item_id: itemId, event_id: "speech" });
    session.receive({ type: "conversation.item.input_audio_transcription.delta", item_id: itemId, delta: "Keep this", event_id: "delta" });
    expect(engine.logs.read("voice-chat").filter(entry => entry.sessionId === session.id)).toHaveLength(0);
    const final = { type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript: "Keep this ordered voice request", event_id: "final" };
    session.receive(final);
    session.receive(final);
    session.receive({ ...final, event_id: "duplicate-final" });
    session.receive({ type: "conversation.item.input_audio_transcription.delta", item_id: itemId, delta: "late delta", event_id: "late-delta" });
    await expect.poll(() => engine.logs.read("voice-chat").filter(entry => entry.sessionId === session.id).length).toBe(1);
    expect(events.filter(event => event.type === "caption" && event.caption.final)).toHaveLength(1);
    session.receive({ type: "response.done", event_id: "response-done", response: { status: "completed", usage: { input_tokens: 20, output_tokens: 10 } } });
    session.receive({ type: "response.done", event_id: "response-done", response: { status: "completed", usage: { input_tokens: 20, output_tokens: 10 } } });
    expect(() => session.acknowledge("another-session-call", { status: "completed", message: "Forged outcome" })).toThrow("no longer pending");
    await session.close();
    session.receive({ ...final, item_id: "after-stop", event_id: "after-stop" });
    expect(engine.logs.read("voice-chat").filter(entry => entry.sessionId === session.id)).toHaveLength(1);
    expect(engine.logs.read("voice-session-closed").find(entry => entry.operationId === session.id)).toMatchObject({ count: 1, inputTokens: 20, outputTokens: 10 });
  });

  it("carries a superseded prepare_workspace_action onto a continuation clause", async () => {
    const provider = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const sent: { type?: string; item?: Record<string, unknown> }[] = [];
    provider.on("connection", socket => {
      socket.on("message", data => {
        const event = JSON.parse(String(data)) as { type?: string; item?: Record<string, unknown> };
        sent.push(event);
        if (event.type === "session.update") socket.send(JSON.stringify({ type: "session.updated", event_id: "configured" }));
      });
    });
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("No provider address");
    process.env.VIDEOBOOK_XAI_REALTIME_URL = `ws://127.0.0.1:${address.port}`;
    const session = new VoiceSession(books, bookId, notebookId, engine, "local-endpoint-key", 120_000, () => undefined, "xai", 48000);
    const events: VoiceSessionEvent[] = [];
    try {
      session.subscribe(event => events.push(event));
      await session.start("", new AbortController().signal);
      session.receive({ type: "input_audio_buffer.speech_started", item_id: "image-turn", event_id: "image-speech" });
      session.receive({ type: "input_audio_buffer.speech_stopped", event_id: "image-stop" });
      session.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "image-turn", transcript: "generate an image", event_id: "image-final",
      });
      await expect.poll(() => engine.logs.read("voice-chat").filter(entry =>
        entry.sessionId === session.id && entry.role === "user").length).toBe(1);
      session.receive({ type: "response.created", response: { id: "image-response" }, event_id: "image-reply" });
      session.receive({ type: "input_audio_buffer.speech_started", item_id: "clause-turn", event_id: "clause-speech" });
      session.receive({ type: "input_audio_buffer.speech_stopped", event_id: "clause-stop" });
      session.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "clause-turn", transcript: "of a kitten", event_id: "clause-final",
      });
      await expect.poll(() => engine.logs.read("voice-chat").filter(entry =>
        entry.sessionId === session.id && entry.role === "user").length).toBe(2);
      session.receive({
        type: "response.function_call_arguments.done", response_id: "image-response", call_id: "image-call",
        name: "prepare_workspace_action", event_id: "image-call-done",
        arguments: JSON.stringify({ tool: "generate_image", params: { prompt: "an image" } }),
      });
      session.receive({
        type: "response.done", event_id: "image-response-done",
        response: { id: "image-response", status: "completed" },
      });
      await expect.poll(() => events.some(event => event.type === "action")).toBe(true);
      const action = events.find(event => event.type === "action");
      if (!action || action.type !== "action") throw new Error("expected a carried-over action");
      expect(action.prompt).toBe("generate an image of a kitten");
      expect(action.plan).toMatchObject({
        kind: "chat-action-plan",
        effect: "generation",
        params: { prompt: "generate an image of a kitten" },
      });
      session.acknowledge(action.callId, { status: "review", message: "Review the image generation." });
      await expect.poll(() => sent.some(event => event.type === "conversation.item.create")).toBe(true);
      const answered = sent.filter(event => event.type === "conversation.item.create").map(event => event.item);
      expect(answered).toHaveLength(1);
      expect(answered[0]).toMatchObject({ type: "function_call_output", call_id: "image-call" });
      expect(JSON.parse(String(answered[0]?.output))).toMatchObject({
        status: "review",
        message: "Review the image generation.",
        workspace: { book: "voice-session", notebookId },
      });
      expect(String(answered[0]?.output)).not.toMatch(/nothing is running/iu);
      expect(sent.some(event => event.type === "response.create")).toBe(true);
    } finally {
      await session.close();
      delete process.env.VIDEOBOOK_XAI_REALTIME_URL;
      await new Promise<void>(resolve => provider.close(() => resolve()));
    }
  });

  it("answers a superseded prepare_workspace_action without running it when the speaker starts a new request", async () => {
    const provider = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const sent: { type?: string; item?: Record<string, unknown> }[] = [];
    provider.on("connection", socket => {
      socket.on("message", data => {
        const event = JSON.parse(String(data)) as { type?: string; item?: Record<string, unknown> };
        sent.push(event);
        if (event.type === "session.update") socket.send(JSON.stringify({ type: "session.updated", event_id: "configured" }));
      });
    });
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("No provider address");
    process.env.VIDEOBOOK_XAI_REALTIME_URL = `ws://127.0.0.1:${address.port}`;
    const session = new VoiceSession(books, bookId, notebookId, engine, "local-endpoint-key", 120_000, () => undefined, "xai", 48000);
    const events: VoiceSessionEvent[] = [];
    try {
      session.subscribe(event => events.push(event));
      await session.start("", new AbortController().signal);
      session.receive({ type: "input_audio_buffer.speech_started", item_id: "image-turn", event_id: "image-speech" });
      session.receive({ type: "input_audio_buffer.speech_stopped", event_id: "image-stop" });
      session.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "image-turn", transcript: "generate an image", event_id: "image-final",
      });
      await expect.poll(() => engine.logs.read("voice-chat").filter(entry =>
        entry.sessionId === session.id && entry.role === "user").length).toBe(1);
      session.receive({ type: "response.created", response: { id: "image-response" }, event_id: "image-reply" });
      session.receive({ type: "input_audio_buffer.speech_started", item_id: "new-turn", event_id: "new-speech" });
      session.receive({ type: "input_audio_buffer.speech_stopped", event_id: "new-stop" });
      session.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "new-turn", transcript: "what's on the board", event_id: "new-final",
      });
      await expect.poll(() => engine.logs.read("voice-chat").filter(entry =>
        entry.sessionId === session.id && entry.role === "user").length).toBe(2);
      session.receive({
        type: "response.function_call_arguments.done", response_id: "image-response", call_id: "image-call",
        name: "prepare_workspace_action", event_id: "image-call-done",
        arguments: JSON.stringify({ tool: "generate_image", params: { prompt: "an image" } }),
      });
      await expect.poll(() => sent.some(event => event.type === "conversation.item.create")).toBe(true);
      const answered = sent.filter(event => event.type === "conversation.item.create").map(event => event.item);
      expect(answered).toHaveLength(1);
      expect(answered[0]).toMatchObject({ type: "function_call_output", call_id: "image-call" });
      expect(String(answered[0]?.output)).toMatch(/nothing is running/iu);
      expect(JSON.parse(String(answered[0]?.output))).toMatchObject({
        workspace: { book: "voice-session", notebookId },
      });
      expect(events.some(event => event.type === "action")).toBe(false);
      expect(sent.filter(event => event.type === "response.create")).toHaveLength(0);
    } finally {
      await session.close();
      delete process.env.VIDEOBOOK_XAI_REALTIME_URL;
      await new Promise<void>(resolve => provider.close(() => resolve()));
    }
  });

  it("sends the model the board again once it changes", async () => {
    const provider = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const sent: { type?: string; session?: { instructions?: string } }[] = [];
    provider.on("connection", socket => {
      socket.on("message", data => {
        const event = JSON.parse(String(data)) as { type?: string; session?: { instructions?: string } };
        sent.push(event);
        if (event.type === "session.update") socket.send(JSON.stringify({ type: "session.updated", event_id: "configured" }));
      });
    });
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("No provider address");
    process.env.VIDEOBOOK_XAI_REALTIME_URL = `ws://127.0.0.1:${address.port}`;
    const session = new VoiceSession(books, bookId, notebookId, engine, "local-endpoint-key", 120_000, () => undefined, "xai", 48000);
    try {
      session.subscribe(() => undefined);
      await session.start("", new AbortController().signal);
      const instructionsOf = () => sent
        .filter(event => event.type === "session.update")
        .map(event => String(event.session?.instructions ?? ""));
      expect(instructionsOf()).toHaveLength(1);
      expect(instructionsOf()[0]).not.toMatch(/@b5/u);

      // A cell the session never heard about, the way an action of its own or a
      // click on the canvas would create one.
      const cell = engine.notebooks.createCell({ type: "image", slot: { row: 1, column: 4 }, label: "Storyboard" });
      const inserted = await engine.notebooks.insertCell(notebookId, cell);
      expect(inserted.ok).toBe(true);

      await expect.poll(() => instructionsOf().length, { timeout: 10_000 }).toBe(2);
      expect(instructionsOf()[1]).toMatch(/@b5/u);
      expect(instructionsOf()[1]).toMatch(/Storyboard/u);

      // An unchanged board is not re-sent every second.
      await new Promise(resolve => setTimeout(resolve, 2_500));
      expect(instructionsOf()).toHaveLength(2);
    } finally {
      await session.close();
      delete process.env.VIDEOBOOK_XAI_REALTIME_URL;
      await new Promise<void>(resolve => provider.close(() => resolve()));
    }
  });

  it("orders user history before a reply when transcription finishes after native speech", async () => {
    const session = new VoiceSession(books, bookId, notebookId, engine, "unused-without-start", 120_000, () => undefined);
    const events: VoiceSessionEvent[] = [];
    session.subscribe(event => events.push(event));
    session.receive({ type: "input_audio_buffer.speech_started", item_id: "late-user", event_id: "started" });
    session.receive({ type: "response.created", response: { id: "early-response" }, event_id: "response" });
    session.receive({ type: "response.output_audio_transcript.done", response_id: "early-response", item_id: "early-answer", transcript: "Ready for your next command", event_id: "answer" });
    expect(engine.logs.read("voice-chat").filter(entry => entry.sessionId === session.id)).toHaveLength(0);
    session.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "late-user", transcript: "Say ready", event_id: "transcription" });
    await session.close();
    const history = engine.logs.read("voice-chat").filter(entry => entry.sessionId === session.id).sort((a, b) => Number(a.ts) - Number(b.ts));
    expect(history.map(entry => entry.role)).toEqual(["user", "assistant"]);
    expect(events.filter(event => event.type === "caption")[0]).toMatchObject({ caption: { role: "user", final: false } });
  });

  describe("voice activation line", () => {
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

    function pause(ms: number): Promise<void> {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    }

    async function startXaiSession(): Promise<{ id: string; token: string }> {
      const response = await fetch(`${origin}/api/voice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId, notebookId, mode: "xai", sampleRate: 24_000 }) });
      if (response.status !== 201) throw new Error(`Session start failed: ${response.status} ${await response.text()}`);
      return await response.json() as { id: string; token: string };
    }

    async function openEventStream(id: string, token: string) {
      const response = await fetch(`${origin}/api/voice/${id}/events`, { headers: bearer(token) });
      if (response.status !== 200 || !response.body) throw new Error(`Event stream failed: ${response.status}`);
      const events: VoiceSessionEvent[] = [];
      const reading = (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body!) {
          buffer += decoder.decode(chunk, { stream: true });
          let index;
          while ((index = buffer.indexOf("\n")) >= 0) {
            events.push(JSON.parse(buffer.slice(0, index)) as VoiceSessionEvent);
            buffer = buffer.slice(index + 1);
          }
        }
      })();
      return { events, reading };
    }

    async function withEndpoint(test: (endpoint: XaiRealtimeEndpoint) => Promise<void>): Promise<void> {
      const endpoint = new XaiRealtimeEndpoint();
      const url = await endpoint.listen();
      process.env.XAI_API_KEY = "local-endpoint-key";
      process.env.VIDEOBOOK_XAI_REALTIME_URL = url;
      try {
        await test(endpoint);
      } finally {
        delete process.env.XAI_API_KEY;
        delete process.env.VIDEOBOOK_XAI_REALTIME_URL;
        await endpoint.close();
      }
    }

    it("pins the OpenAI activation builder", () => {
      const event = openAiVoiceActivationEvent();
      expect(event.type).toBe("response.create");
      expect(event.response).toMatchObject({ input: [], tool_choice: "none", metadata: { purpose: "activation" } });
      expect(String(event.response?.instructions)).toContain("Say exactly");
      expect(String(event.response?.instructions)).toContain(VOICE_ACTIVATION_PHRASE);
    });

    it("greets once through the real router when the browser reports ready", async () => {
      await withEndpoint(async endpoint => {
        const { id, token } = await startXaiSession();
        const { events, reading } = await openEventStream(id, token);
        const ready = await fetch(`${origin}/api/voice/${id}/ready`, { method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" }, body: "{}" });
        expect(ready.status).toBe(204);
        await expect.poll(() => endpoint.forceMessageItems()).toHaveLength(1);
        expect(endpoint.forceMessageItems()[0]).toMatchObject({ type: "force_message", role: "assistant", content: [{ type: "output_text", text: "Voice Chat Activated" }] });
        expect(endpoint.sent.filter(event => event.type === "response.create")).toHaveLength(0);
        await expect.poll(() => events.some(event => event.type === "caption" && event.caption.role === "assistant" && event.caption.final)).toBe(true);
        expect(events.filter(event => event.type === "caption" && event.caption.final)).toHaveLength(1);
        expect(events.find(event => event.type === "caption" && event.caption.final)).toMatchObject({ caption: { role: "assistant", text: "Voice Chat Activated" } });
        expect(events.some(event => event.type === "audio")).toBe(true);
        expect(events.some(event => event.type === "error" || event.type === "closed")).toBe(false);
        await expect.poll(() => engine.logs.read("voice-chat").filter(entry => entry.sessionId === id).length).toBe(0);
        expect(JSON.stringify(voiceWorkspaceContext(engine, notebookId).recentConversation)).not.toContain("Voice Chat Activated");
        await pause(300);
        expect(engine.logs.read("voice-chat").filter(entry => entry.sessionId === id)).toHaveLength(0);

        const again = await fetch(`${origin}/api/voice/${id}/ready`, { method: "POST", headers: bearer(token) });
        expect(again.status).toBe(204);
        await pause(300);
        expect(endpoint.forceMessageItems()).toHaveLength(1);
        expect((await fetch(`${origin}/api/voice/${id}/ready`, { method: "POST", headers: bearer("nope") })).status).toBe(404);
        expect((await fetch(`${origin}/api/voice/${id}/ready`, { method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" }, body: JSON.stringify({ extra: true }) })).status).toBe(400);

        await fetch(`${origin}/api/voice/${id}`, { method: "DELETE", headers: bearer(token) });
        await reading;
        expect((await fetch(`${origin}/api/voice/${id}/ready`, { method: "POST", headers: bearer(token) })).status).toBe(404);
      });
    });

    it("finalizes the activation caption on response.done without transcript events", async () => {
      await withEndpoint(async endpoint => {
        endpoint.onActivation = send => sendActivationResponse(send, { transcript: null });
        const { id, token } = await startXaiSession();
        const { events, reading } = await openEventStream(id, token);
        await fetch(`${origin}/api/voice/${id}/ready`, { method: "POST", headers: bearer(token) });
        await expect.poll(() => events.some(event => event.type === "caption" && event.caption.role === "assistant" && event.caption.final)).toBe(true);
        expect(events.filter(event => event.type === "caption" && event.caption.final)).toHaveLength(1);
        expect(events.find(event => event.type === "caption" && event.caption.final)).toMatchObject({ caption: { role: "assistant", text: "Voice Chat Activated" } });
        expect(events.some(event => event.type === "audio")).toBe(true);
        expect(engine.logs.read("voice-chat").filter(entry => entry.sessionId === id)).toHaveLength(0);
        await fetch(`${origin}/api/voice/${id}`, { method: "DELETE", headers: bearer(token) });
        await reading;
      });
    });

    it("keeps the interrupted line out of the history", async () => {
      await withEndpoint(async endpoint => {
        const { id, token } = await startXaiSession();
        const { events, reading } = await openEventStream(id, token);
        await fetch(`${origin}/api/voice/${id}/ready`, { method: "POST", headers: bearer(token) });
        await expect.poll(() => events.some(event => event.type === "caption" && event.caption.role === "assistant" && event.caption.final)).toBe(true);
        const interrupt = await fetch(`${origin}/api/voice/${id}/interrupt`, { method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" }, body: JSON.stringify({ responseId: "activation-response-1", itemId: "activation-item-1", audioEndMs: 200 }) });
        expect(interrupt.status).toBe(204);
        await expect.poll(() => endpoint.sent.some(event => event.type === "conversation.item.truncate")).toBe(true);
        endpoint.send({ type: "conversation.item.truncated", event_id: "truncated", item_id: "activation-item-1", response_id: "activation-response-1" });
        await expect.poll(() => events.some(event => event.type === "caption" && event.caption.interrupted)).toBe(true);
        expect(events.some(event => event.type === "error" || event.type === "closed")).toBe(false);
        await expect.poll(() => engine.logs.read("voice-chat").filter(entry => entry.sessionId === id).length).toBe(0);
        expect(JSON.stringify(voiceWorkspaceContext(engine, notebookId).recentConversation)).not.toContain("Voice Chat Activated");
        await fetch(`${origin}/api/voice/${id}`, { method: "DELETE", headers: bearer(token) });
        await reading;
      });
    });

    it("stays silent when the speaker starts before ready arrives", async () => {
      await withEndpoint(async endpoint => {
        const { id, token } = await startXaiSession();
        const { events, reading } = await openEventStream(id, token);
        endpoint.send({ type: "input_audio_buffer.speech_started", event_id: "early-speech", item_id: "early-turn" });
        await expect.poll(() => events.some(event => event.type === "caption" && event.caption.role === "user")).toBe(true);
        const ready = await fetch(`${origin}/api/voice/${id}/ready`, { method: "POST", headers: bearer(token) });
        expect(ready.status).toBe(204);
        await pause(300);
        expect(endpoint.forceMessageItems()).toHaveLength(0);
        expect(endpoint.sent.some(event => event.type === "response.create")).toBe(false);
        await fetch(`${origin}/api/voice/${id}`, { method: "DELETE", headers: bearer(token) });
        await reading;
      });
    });

    it("keeps the session when the provider rejects the line and answers later turns", async () => {
      await withEndpoint(async endpoint => {
        endpoint.onActivation = send => { send({ type: "error", event_id: "activation-error", error: { code: "conversation_already_has_active_response" } }); };
        const { id, token } = await startXaiSession();
        const { events, reading } = await openEventStream(id, token);
        await fetch(`${origin}/api/voice/${id}/ready`, { method: "POST", headers: bearer(token) });
        await expect.poll(() => endpoint.forceMessageItems()).toHaveLength(1);
        await pause(300);
        expect(events.some(event => event.type === "error" || event.type === "closed")).toBe(false);

        endpoint.send({ type: "input_audio_buffer.speech_started", event_id: "turn-speech", item_id: "turn-1" });
        endpoint.send({ type: "input_audio_buffer.speech_stopped", event_id: "turn-stop" });
        endpoint.send({ type: "conversation.item.input_audio_transcription.completed", event_id: "turn-final", item_id: "turn-1", transcript: "rename this image" });
        endpoint.send({ type: "response.created", event_id: "turn-created", response_id: "reply-1", response: { id: "reply-1" } });
        endpoint.send({ type: "response.function_call_arguments.done", event_id: "turn-call", response_id: "reply-1", call_id: "call-1", name: "find_workspace_actions", arguments: JSON.stringify({ query: "rename image" }) });
        await expect.poll(() => endpoint.sent.some(event => event.type === "conversation.item.create" && event.item?.type === "function_call_output")).toBe(true);
        const output = endpoint.sent.find(event => event.type === "conversation.item.create" && event.item?.type === "function_call_output");
        expect(JSON.parse(String(output?.item?.output))).toMatchObject({ actions: expect.anything() });
        endpoint.send({ type: "response.done", event_id: "reply-done", response_id: "reply-1", response: { id: "reply-1", status: "completed" } });
        await expect.poll(() => endpoint.sent.filter(event => event.type === "response.create")).toHaveLength(1);
        endpoint.send({ type: "response.output_audio_transcript.done", event_id: "reply-answer", response_id: "reply-1", item_id: "reply-answer", transcript: "Rename is on screen." });
        await expect.poll(() => events.some(event => event.type === "caption" && event.caption.final && event.caption.text === "Rename is on screen.")).toBe(true);
        expect(events.some(event => event.type === "error" || event.type === "closed")).toBe(false);
        expect(endpoint.forceMessageItems()).toHaveLength(1);
        await fetch(`${origin}/api/voice/${id}`, { method: "DELETE", headers: bearer(token) });
        await reading;
      });
    });

    it("ends the session with billing guidance when credits run out during the line", async () => {
      await withEndpoint(async endpoint => {
        endpoint.onActivation = send => { send({ type: "error", event_id: "credit-error", error: { code: "credit_balance_exhausted", message: "Private provider details" } }); };
        const { id, token } = await startXaiSession();
        const { events, reading } = await openEventStream(id, token);
        await fetch(`${origin}/api/voice/${id}/ready`, { method: "POST", headers: bearer(token) });
        await expect.poll(() => events.some(event => event.type === "closed")).toBe(true);
        expect(events.find(event => event.type === "error")).toMatchObject({ message: expect.stringContaining("Add credits in xAI billing") });
        expect(JSON.stringify(events)).not.toContain("Private provider details");
        await reading;
      });
    });
  });
});
