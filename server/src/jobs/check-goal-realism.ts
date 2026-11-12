import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Engine } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import { requireApiKey } from "../api-key.js";
import { chatIntelligenceRequestOptions } from "../chat-models.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import { readGoal, requireGoalShortContent, saveGoal, type GoalRealismCheck, type GoalRealismFinding } from "../goal-store.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { buildIntelligenceResponses, firstResponseText, intelligenceRequest } from "../openai-intelligence.js";
import { registerJobHandler } from "../queue.js";
import { mimeForImageFilename } from "./describe-image.js";

const REALISM_FINDING_LIMIT = 5;
const REALISM_WORD_LIMIT = 20;
const SEGMENT_SAMPLES = 4;

const INSTRUCTIONS = [
  "You check a frame or a clip of a short that must look like real phone footage of one person, never like AI.",
  "The first image is the reference of the main character. The other images are the frame or frames to check.",
  "Look only for these giveaways: extra, missing or fused fingers; garbled or melting text; waxy or airbrushed skin; warped or flickering objects; a face, build or shirt that differs from the reference; mouth movement that reads as speech.",
  "Answer with at most 5 findings, each at most 20 words, naming where it shows. Use warn for a giveaway a viewer would notice and note for a small one.",
  "If none of these shows, answer with no findings. Do not mention anything else.",
].join(" ");

const answerSchema = z.object({
  findings: z.array(z.object({ severity: z.enum(["note", "warn"]), text: z.string() })),
});

type RealismPayload = { goalId: string; artifactId: string; stage: "frame" | "videos"; index: number };
type InputPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "high" };

function imageParts(label: string, bytes: Buffer, mime: string): InputPart[] {
  return [{ type: "input_text", text: label }, { type: "input_image", image_url: `data:${mime};base64,${bytes.toString("base64")}`, detail: "high" }];
}

async function storedImage(engine: Engine, artifactId: string, label: string): Promise<InputPart[]> {
  const manifest = await engine.files.manifest(artifactId);
  const file = manifest.ok ? findPrimaryMediaFile(manifest.value.files, "image") : null;
  if (!file) throw new Error(`${label} has no readable image`);
  const bytes = await engine.files.read(artifactId, file.name);
  if (!bytes.ok) throw new Error(bytes.error.message);
  return imageParts(label, Buffer.from(bytes.value), mimeForImageFilename(file.name));
}

async function segmentFrames(engine: Engine, artifactId: string, seconds: number, signal: AbortSignal): Promise<InputPart[]> {
  const manifest = await engine.files.manifest(artifactId);
  const file = manifest.ok ? findPrimaryMediaFile(manifest.value.files, "video") : null;
  if (!manifest.ok || !file) throw new Error("The clip has no readable video");
  const path = join(manifest.value.path, file.name);
  const duration = (await probeVideo(path)).duration;
  const span = Math.min(seconds, duration);
  const start = duration - span;
  const scratch = await mkdtemp(join(tmpdir(), "videobook-goal-realism-"));
  try {
    const parts: InputPart[] = [];
    for (let sample = 0; sample < SEGMENT_SAMPLES; sample += 1) {
      signal.throwIfAborted();
      const at = start + span * (sample + 0.5) / SEGMENT_SAMPLES;
      const output = join(scratch, `frame-${sample}.jpg`);
      await runFfmpeg(["-y", "-v", "error", "-ss", at.toFixed(3), "-i", path, "-frames:v", "1", "-q:v", "3", output]);
      parts.push(...imageParts(`Clip frame at ${at.toFixed(2)}s`, await readFile(output), "image/jpeg"));
    }
    return parts;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function shortened(text: string): string {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  return words.length > REALISM_WORD_LIMIT ? `${words.slice(0, REALISM_WORD_LIMIT).join(" ")}…` : words.join(" ");
}

function realismFindings(findings: readonly GoalRealismFinding[]): GoalRealismFinding[] {
  return findings
    .map((finding, position) => ({ finding, position }))
    .filter(({ finding }) => finding.text.trim())
    .sort((left, right) => (left.finding.severity === right.finding.severity ? left.position - right.position : left.finding.severity === "warn" ? -1 : 1))
    .slice(0, REALISM_FINDING_LIMIT)
    .map(({ finding }) => ({ severity: finding.severity, text: shortened(finding.text) }));
}

async function checkRealism(engine: Engine, payload: RealismPayload, signal: AbortSignal): Promise<GoalRealismFinding[]> {
  const goal = readGoal(engine, payload.goalId);
  const plan = requireGoalShortContent(engine, goal).plan;
  if (!plan) throw new Error("This short has no plan to check against");
  const reference = plan.character.references[0];
  const subject = payload.stage === "frame"
    ? await storedImage(engine, payload.artifactId, "Frame to check")
    : await segmentFrames(engine, payload.artifactId, plan.segments[payload.index]?.seconds ?? 0, signal);
  const options = chatIntelligenceRequestOptions();
  const responses = buildIntelligenceResponses(requireApiKey("OPENAI_API_KEY"), options);
  const request = {
    instructions: INSTRUCTIONS,
    input: [{ role: "user" as const, content: [
      { type: "input_text" as const, text: JSON.stringify({ character: plan.character.description, checking: payload.stage === "frame" ? "opening frame" : `clip ${payload.index + 1}` }) },
      ...(reference ? await storedImage(engine, reference.artifactId, "Character reference") : []),
      ...subject,
    ] }],
    text: { format: { type: "json_schema" as const, name: "realism_findings", strict: true, schema: z.toJSONSchema(answerSchema) } },
    max_output_tokens: 1200,
  };
  const answer = answerSchema.parse(JSON.parse(firstResponseText(await responses(intelligenceRequest(request, options), signal))));
  return realismFindings(answer.findings);
}

async function recordCheck(engine: Engine, goalId: string, artifactId: string, result: Omit<GoalRealismCheck, "jobId">): Promise<void> {
  await withNotebookMutation(`goal:${goalId}`, async () => {
    const goal = readGoal(engine, goalId);
    const previous = goal.realism?.[artifactId];
    saveGoal(engine, { ...goal, realism: { ...goal.realism, [artifactId]: { ...result, jobId: previous?.jobId ?? null } } });
  });
}

export function registerCheckGoalRealismJob(engine: Engine): void {
  registerJobHandler("check_goal_realism", async (payload, context) => {
    const check = payload as unknown as RealismPayload;
    try {
      const findings = await checkRealism(engine, check, context.signal);
      await recordCheck(engine, check.goalId, check.artifactId, { status: "completed", checkedAt: new Date().toISOString(), findings, error: null });
      return { goalId: check.goalId, artifactId: check.artifactId, findings: findings.length };
    } catch (error) {
      await recordCheck(engine, check.goalId, check.artifactId, { status: "failed", checkedAt: new Date().toISOString(), findings: [], error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
}
