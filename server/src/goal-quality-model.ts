import { z } from "zod";

export const goalOutputAssertionsSchema = z.object({
  version: z.literal(1),
  checks: z.array(z.enum(["decode", "current-inputs", "duration", "frame-count", "geometry", "audio", "kept-source", "identity", "overlays", "action", "reveal"])),
}).strict();

export const goalQualityFindingSchema = z.object({
  code: z.string(), severity: z.enum(["error", "review", "note"]), text: z.string().max(600),
  atSeconds: z.number().nonnegative().nullable(), correction: z.string().max(600).nullable(),
}).strict();
export type GoalQualityFinding = z.infer<typeof goalQualityFindingSchema>;

export const goalQualityResultSchema = z.object({
  technical: z.object({
    status: z.enum(["pass", "fail", "unverified"]), findings: z.array(goalQualityFindingSchema),
    durationSeconds: z.number().nonnegative().nullable(), frameCount: z.number().int().nonnegative().nullable(),
  }).strict(),
  semantic: z.object({
    status: z.enum(["not-requested", "unverified", "pass", "fail"]), findings: z.array(goalQualityFindingSchema),
    sampleTimes: z.array(z.number().nonnegative()), model: z.string().nullable(), attempted: z.boolean(),
  }).strict(),
  checkedAt: z.string(),
}).strict();
export type GoalQualityResult = z.infer<typeof goalQualityResultSchema>;

export type GoalOutputCheck = {
  status: "running" | "completed" | "failed";
  key: string;
  artifactId: string;
  mediaHash: string;
  stage: "frame" | "videos" | "finish";
  index: number;
  semantic: boolean;
  jobId: number | null;
  result: GoalQualityResult | null;
  error: string | null;
};

export function goalQualityAccepted(result: GoalQualityResult | null | undefined, semanticRequired: boolean): boolean {
  return result?.technical.status === "pass" && (result.semantic.status === "pass" || !semanticRequired && result.semantic.status === "not-requested")
    && ![...result.technical.findings, ...result.semantic.findings].some(finding => finding.severity !== "note");
}
