import { z } from "zod";
import { cleanupRegionsSchema } from "./video-cleanup/model.js";

export const remixPreferencesSchema = z.object({
  version: z.literal(1).default(1),
  structure: z.enum(["auto", "preserve-source", "regenerate", "single-take"]).default("auto"),
  character: z.enum(["auto", "insert", "replace"]).default("auto"),
  audio: z.enum(["source", "generated", "mute", "mix"]).default("source"),
  cleanup: z.enum(["review", "remove", "keep"]).default("review"),
  cleanupMethod: z.enum(["lama", "fill"]).default("lama"),
  semanticChecks: z.boolean().default(false),
  autoContinue: z.boolean().default(false),
  allowanceUsd: z.number().positive().nullable().default(null),
  reviewImages: z.boolean().default(true),
  branding: z.boolean().default(true),
}).strict();

export type RemixPreferences = z.infer<typeof remixPreferencesSchema>;

const rangeSchema = z.object({ start: z.number().nonnegative(), end: z.number().positive() }).strict()
  .refine((range) => range.end > range.start, "The range must end after it starts.");

const remixObservationSchema = z.object({
  summary: z.string().max(1600),
  subjects: z.array(z.string().max(200)).max(20),
  actions: z.array(z.object({ atSeconds: z.number().nonnegative(), description: z.string().max(300) }).strict()).max(20),
  overlays: z.array(z.object({
    description: z.string().max(300),
    kind: z.enum(["overlay", "physical", "uncertain"]),
    x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    width: z.number().positive().max(1), height: z.number().positive().max(1),
    start: z.number().nonnegative(), end: z.number().positive(),
  }).strict()).max(40),
}).strict();

export const remixUnderstandingSchema = z.object({
  structure: z.enum(["preserve-source", "regenerate", "single-take"]),
  character: z.enum(["insert", "replace"]),
  action: rangeSchema.nullable(),
  actionDescription: z.string().max(600),
  sourceFrameSeconds: z.number().nonnegative().nullable(),
  observations: remixObservationSchema,
  uncertainties: z.array(z.string().max(500)).max(12),
}).strict();

export type RemixUnderstanding = z.infer<typeof remixUnderstandingSchema>;

export const remixSourceEvidenceSchema = z.object({
  mediaHash: z.string().min(1),
  durationSeconds: z.number().positive(),
  fps: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  hasAudio: z.boolean(),
  cuts: z.array(z.number().nonnegative()),
  sampleTimes: z.array(z.number().nonnegative()).max(12),
  observations: remixObservationSchema.nullable(),
  semanticStatus: z.enum(["missing", "imported", "sampled"]),
  transcript: z.string().max(6000).nullable(),
  evidenceKey: z.string(),
}).strict();

export type RemixSourceEvidence = z.infer<typeof remixSourceEvidenceSchema>;

export const remixFindingSchema = z.object({
  code: z.string(),
  severity: z.enum(["note", "review", "error"]),
  text: z.string(),
}).strict();

export type RemixFinding = z.infer<typeof remixFindingSchema>;

export const goalRemixAnalysisSchema = z.object({
  version: z.literal(1),
  brief: z.string(),
  preferences: remixPreferencesSchema,
  source: remixSourceEvidenceSchema.extend({ artifactId: z.string() }).nullable(),
  intent: z.object({
    structure: z.enum(["preserve-source", "regenerate", "single-take"]),
    character: z.enum(["insert", "replace"]),
    audio: z.enum(["source", "generated", "mute", "mix"]),
    cleanup: z.enum(["review", "remove", "keep"]),
    action: rangeSchema.nullable(),
    actionDescription: z.string(),
    noDialogue: z.boolean(),
    origins: z.record(z.string(), z.enum(["brief", "preset", "default", "analysis", "edited"])),
  }).strict(),
  recipe: z.object({
    targetSeconds: z.number().positive(),
    sourceFrameSeconds: z.number().nonnegative().nullable(),
    keep: z.array(rangeSchema),
    change: z.array(rangeSchema),
    generatedSeconds: z.number().positive(),
    reference: rangeSchema.nullable(),
    referenceArtifactId: z.string().nullable().default(null),
    referenceMediaHash: z.string().nullable().default(null),
    preparedArtifactId: z.string().nullable(),
    preparedMediaHash: z.string().nullable(),
    preparedFrameArtifactId: z.string().nullable().default(null),
    preparedFrameMediaHash: z.string().nullable().default(null),
    cleanupRegions: cleanupRegionsSchema,
    cleanupConfirmed: z.boolean(),
    cleanupMethod: z.enum(["lama", "fill"]),
    cleanupReviewedHash: z.string().nullable().default(null),
    cleanupModelReady: z.boolean().default(false),
    cleanupFrames: z.number().int().nonnegative().default(0),
    cleanupCandidates: z.array(z.object({
      artifactId: z.string(), mediaHash: z.string(), method: z.enum(["lama", "fill"]), regions: cleanupRegionsSchema,
      identity: z.string(), reviewed: z.boolean(), reusable: z.boolean(),
    }).strict()).max(30).default([]),
    templateId: z.string().nullable(),
    templateRevision: z.string().nullable(),
    checkTimes: z.array(z.number().nonnegative()),
  }).strict(),
  history: z.array(z.object({
    goalId: z.string(), artifactId: z.string().nullable(),
    stage: z.string(), selected: z.boolean(), status: z.string(),
    failure: z.enum(["account", "request", "transport", "quality", "unknown"]).nullable(),
  }).strict()).max(100),
  findings: z.array(remixFindingSchema),
  analyzedAt: z.string(),
}).strict();

export type GoalRemixAnalysis = z.infer<typeof goalRemixAnalysisSchema>;

function numericSeconds(text: string): number {
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15 };
  return words[text.toLowerCase()] ?? Number(text);
}

function briefActionRange(brief: string, totalSeconds: number): { start: number; end: number } | null {
  const last = /\b(?:last|final)\s+(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)[ -]*(?:seconds?|secs?|s)\b/iu.exec(brief);
  if (last) {
    const seconds = numericSeconds(last[1]!);
    if (seconds > 0 && seconds < totalSeconds) return { start: totalSeconds - seconds, end: totalSeconds };
  }
  const interval = /\b(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/giu;
  const ranges = [...brief.matchAll(interval)].map(match => ({ start: Number(match[1]), end: Number(match[2]) }));
  const payoff = ranges.find(range => range.start > 0 && range.end === totalSeconds);
  if (payoff) return payoff;
  const absent = /\b(?:absent|not\s+(?:visible|shown|appear)|does\s+not\s+appear|out\s+of\s+(?:the\s+)?(?:frame|shot))[^.!?]{0,60}?\b(?:first|until)\s+(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\s*(?:seconds?|secs?|s)\b/iu.exec(brief);
  const start = absent ? numericSeconds(absent[1]!) : null;
  return start !== null && start > 0 && start < totalSeconds ? { start, end: totalSeconds } : null;
}

export function resolveRemixIntent(input: {
  brief: string; totalSeconds: number; source: boolean; preferences: RemixPreferences; understanding?: RemixUnderstanding | null;
}): GoalRemixAnalysis["intent"] {
  const { source, preferences, understanding } = input;
  const prose = input.brief.replace(/\b(?:replace|replacement|twist|frame|video|beat\s*\d+)\s*:\s*["“][^"”]*["”]/giu, " ").trim();
  const brief = prose || input.brief;
  const origins: GoalRemixAnalysis["intent"]["origins"] = {};
  const action = briefActionRange(brief, input.totalSeconds) ?? understanding?.action ?? null;
  origins.action = briefActionRange(brief, input.totalSeconds) ? "brief" : understanding?.action ? "analysis" : "default";
  const montage = /\b(?:montage|keep (?:the )?(?:source|original|shots)|preserve (?:the )?(?:source|original|shots))\b/iu.test(brief);
  const single = /\b(?:one continuous take|single[ -](?:shot|take)|no cuts)\b/iu.test(brief);
  const regenerate = /\b(?:regenerate|recreate|remake) (?:the )?(?:whole|entire|full)\b/iu.test(brief);
  const structure = regenerate ? "regenerate" : single ? "single-take" : montage && source ? "preserve-source"
    : preferences.structure !== "auto" ? preferences.structure : understanding?.structure ?? (source && action ? "preserve-source" : source ? "regenerate" : "single-take");
  origins.structure = regenerate || single || montage ? "brief" : preferences.structure !== "auto" ? "preset" : understanding ? "analysis" : "default";
  const replace = /\breplace\s+(?:the\s+)?(?:person|man|woman|character|driver|subject)\b/iu.test(brief);
  const insert = /\b(?:insert|enters?|arrives?|appears?|walks? in)\b/iu.test(brief);
  const character = replace ? "replace" : insert ? "insert" : preferences.character !== "auto" ? preferences.character : understanding?.character ?? "insert";
  origins.character = replace || insert ? "brief" : preferences.character !== "auto" ? "preset" : understanding ? "analysis" : "default";
  const mute = /\b(?:mute|no audio|silent soundtrack)\b/iu.test(brief);
  const keepAudio = /\b(?:keep|preserve|use) (?:the )?(?:original|source) (?:audio|sound|music)\b/iu.test(brief);
  const generatedAudio = /\b(?:new|generated) (?:audio|soundtrack|ambience)\b/iu.test(brief);
  const audio = mute ? "mute" : keepAudio ? "source" : generatedAudio ? "generated" : source ? preferences.audio : "generated";
  origins.audio = mute || keepAudio || generatedAudio ? "brief" : source ? "preset" : "default";
  const remove = /\b(?:remove|clear|strip|no)\s+(?:(?:all|the|source|original|on[ -]screen)\s+)*(?:osg|graphics|overlays?|captions?|titles?|watermarks?|logos?|text)\b/iu.test(brief);
  const keep = /\b(?:keep|preserve)\s+(?:(?:the|source|original|on[ -]screen)\s+)*(?:osg|graphics|overlays?|captions?|titles?|watermarks?|logos?|text)\b/iu.test(brief);
  const cleanup = remove ? "remove" : keep ? "keep" : preferences.cleanup;
  origins.cleanup = remove || keep ? "brief" : "preset";
  return { structure, character, audio, cleanup, action, actionDescription: understanding?.actionDescription ?? brief,
    noDialogue: !/\b(?:speaks?|says?|dialogue|narrat(?:es?|ion)|voiceover|sings?)\b/iu.test(brief.replace(/\b(?:no|without)\s+(?:new\s+)?(?:dialogue|narration|voiceover|singing)\b|\bnever\s+(?:speaks?|sings?)\b/giu, "")), origins };
}

export function remixRules(intent: GoalRemixAnalysis["intent"]): { frame: string; video: string; silence: string } {
  return {
    frame: "Candid phone photo in available light. Natural colour, realistic anatomy, unretouched skin and physically supported objects. Keep printing physically on objects." + (intent.cleanup === "keep" ? " Preserve the source graphics." : " No added captions, borders or watermarks."),
    video: `Real phone footage filmed by someone off screen at real-time speed, with natural weight and physics. ${intent.structure === "single-take" ? "One continuous take with slight handheld camera movement." : "Follow the planned shot order and cuts."} ${intent.cleanup === "keep" ? "Preserve the source graphics." : "No added on-screen graphics."}`,
    silence: `${intent.noDialogue ? "The inserted person does not speak or sing. Allow natural mouth movement for the requested action, including eating." : "Follow the requested dialogue and sound."} ${intent.audio === "source" || intent.audio === "mix" ? "Keep the source soundtrack separate for assembly; do not recreate its music or speech." : intent.audio === "mute" ? "The final video is muted." : "Natural ambient sound unless the brief requests otherwise."}`,
  };
}

export function remixPromptFindings(analysis: GoalRemixAnalysis, prompts: readonly string[]): RemixFinding[] {
  const text = prompts.join("\n");
  const findings: RemixFinding[] = [];
  if (analysis.intent.structure === "preserve-source" && /\b(?:no cuts|one continuous take|single take)\b/iu.test(text)) {
    findings.push({ code: "conflicting-cuts", severity: "error", text: "The plan preserves a montage, but a prompt requires one continuous take. Resolve the conflict before generating." });
  }
  if (/\b(?:bite|bites|biting|eat|eats|eating|chew|chews|chewing)\b/iu.test(analysis.brief) && /\b(?:lips|mouth)\s+(?:stay\s+|remain\s+)?closed\b/iu.test(text)) {
    findings.push({ code: "conflicting-action", severity: "error", text: "The requested eating action conflicts with keeping the mouth closed. Edit that prompt before generating." });
  }
  return findings;
}
