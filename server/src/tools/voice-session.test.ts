import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import express from "express";
import { OpenAiError } from "@apicity/openai";
import { XaiError } from "@apicity/xai";
import { OpenAiRealtimeCallRequestSchema } from "@apicity/openai/zod";
import { BookManager } from "../book-manager.js";
import { VoiceSession, VoiceSessions, voiceError } from "../voice-session.js";
import { voiceRouter } from "../voice-http.js";
import { attachVoiceAudio } from "../voice-audio.js";
import { restrictHttpAccess } from "../http-access.js";
import { voiceSessionConfig } from "../voice-config.js";
import type { Engine } from "videobook-engine";
import { appendVoiceHistory } from "./chat-history.js";
import { voiceWorkspaceContext } from "../voice-actions.js";
import type { VoiceSessionEvent } from "../voice-contract.js";

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
    expect(request.session?.tools?.map(tool => "name" in tool ? tool.name : "")).toEqual(["find_workspace_actions", "prepare_workspace_action"]);
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
});
