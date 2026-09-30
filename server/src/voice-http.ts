import express from "express";
import { z } from "zod";
import type { VoiceSessions } from "./voice-session.js";
import { voiceError } from "./voice-session.js";

const startSchema = z.object({
  bookId: z.string().uuid(), notebookId: z.string().uuid().optional(),
  mode: z.enum(["auto", "openai", "xai"]).default("openai"),
  sampleRate: z.union([z.literal(8000), z.literal(16000), z.literal(22050), z.literal(24000), z.literal(32000), z.literal(44100), z.literal(48000)]).optional(),
  sdp: z.string().min(20).max(64_000).startsWith("v=0").optional(),
}).strict().refine(value => value.mode === "xai" || value.sdp !== undefined);
const outcomeSchema = z.object({ callId: z.string().min(1).max(200), outcome: z.object({ status: z.enum(["review", "completed", "queued", "failed", "cancelled"]), message: z.string().min(1).max(4000) }).strict() }).strict();
const contextSchema = z.object({ userText: z.string().max(8000), assistantText: z.string().max(4000) }).strict();

export function voiceRouter(sessions: VoiceSessions) {
  const router = express.Router();
  router.use(express.json({ limit: "80kb" }));
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.post("/", async (req, res) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Voice requires a valid project, notebook and bounded SDP offer." }); return; }
    const abort = new AbortController();
    const cancelled = () => { if (!res.writableFinished) abort.abort(); };
    res.on("close", cancelled);
    try { res.status(201).json(await sessions.start(parsed.data, abort.signal)); }
    catch (error) { const failure = voiceError(error); if (!res.destroyed) res.status(failure.status).json({ error: failure.message }); }
    finally { res.off("close", cancelled); }
  });
  router.get("/:id/events", (req, res) => {
    try {
      const session = sessions.get(req.params.id, req.get("authorization")?.replace(/^Bearer /u, "") ?? "");
      session.subscribe((event) => {
        if (res.destroyed) return;
        if (!res.headersSent) { res.setHeader("Content-Type", "application/x-ndjson"); res.setHeader("X-Accel-Buffering", "no"); res.flushHeaders(); }
        const accepted = res.write(`${JSON.stringify(event)}\n`);
        if (event.type === "closed") res.end();
        else if (!accepted && res.writableLength > 256_000) { res.destroy(); void session.close("Voice event connection stalled."); }
      });
      if (!res.headersSent) { res.setHeader("Content-Type", "application/x-ndjson"); res.setHeader("X-Accel-Buffering", "no"); res.flushHeaders(); }
      res.on("close", () => { void session.close(); });
    } catch (error) { const failure = voiceError(error); res.status(failure.status).json({ error: failure.message }); }
  });
  router.delete("/:id", async (req, res) => {
    const parsed = z.object({ interruptedResponseId: z.string().max(200).nullable().optional() }).strict().safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "Invalid voice stop request." }); return; }
    try { await sessions.stop(req.params.id, req.get("authorization")?.replace(/^Bearer /u, "") ?? "", parsed.data.interruptedResponseId); res.sendStatus(204); }
    catch (error) { const failure = voiceError(error); res.status(failure.status).json({ error: failure.message }); }
  });
  router.post("/:id/interrupt", (req, res) => {
    const parsed = z.object({ responseId: z.string().min(1).max(200), itemId: z.string().min(1).max(200).optional(), audioEndMs: z.number().int().min(0).max(1_800_000).optional() }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid voice interruption." }); return; }
    try {
      sessions.get(req.params.id, req.get("authorization")?.replace(/^Bearer /u, "") ?? "").interruptPlayback(parsed.data.responseId, parsed.data.itemId, parsed.data.audioEndMs);
      res.sendStatus(204);
    } catch (error) { const failure = voiceError(error); res.status(failure.status).json({ error: failure.message }); }
  });
  router.post("/:id/ready", (req, res) => {
    const parsed = z.object({}).strict().safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "Invalid voice ready request." }); return; }
    try {
      sessions.get(req.params.id, req.get("authorization")?.replace(/^Bearer /u, "") ?? "").greet();
      res.sendStatus(204);
    } catch (error) { const failure = voiceError(error); res.status(failure.status).json({ error: failure.message }); }
  });
  router.post("/:id/outcome", (req, res) => {
    const parsed = outcomeSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid voice action outcome." }); return; }
    try {
      sessions.get(req.params.id, req.get("authorization")?.replace(/^Bearer /u, "") ?? "").acknowledge(parsed.data.callId, parsed.data.outcome);
      res.sendStatus(204);
    } catch (error) { const failure = voiceError(error); res.status(failure.status).json({ error: failure.message }); }
  });
  router.post("/:id/context", (req, res) => {
    const parsed = contextSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid voice context." }); return; }
    try {
      sessions.get(req.params.id, req.get("authorization")?.replace(/^Bearer /u, "") ?? "").contextMessage(parsed.data);
      res.sendStatus(204);
    } catch (error) { const failure = voiceError(error); res.status(failure.status).json({ error: failure.message }); }
  });
  return router;
}
