import type { GoalGenerationStage } from "./goal-store.js";

export type GoalReservation = {
  id: string;
  stage: GoalGenerationStage;
  index: number;
  inputKey: string;
  amountUsd: number;
  warnings: string[];
  status: "reserved" | "submitted" | "settled" | "uncertain" | "released";
  chainId: string | null;
  runIds: string[];
  usageIds: string[];
  spentUsd: number | null;
  submittedArtifactIds: string[];
  createdAt: string;
};

export type GoalAutomation = {
  version: 1;
  id: string;
  status: "running" | "paused" | "completed";
  planKey: string;
  allowanceUsd: number;
  approvedAt: string;
  approvedImages: { artifactId: string; mediaHash: string }[];
  approvedAudio: { artifactId: string; mediaHash: string }[];
  accountReviewedAt: string | null;
  step: string;
  reason: string | null;
  jobId: number | null;
  reservations: GoalReservation[];
};

export function goalAutomationTotals(automation: GoalAutomation) {
  const spent = automation.reservations.reduce((sum, reservation) => sum + (reservation.spentUsd ?? 0), 0);
  const reserved = automation.reservations.filter(reservation => !["released", "settled"].includes(reservation.status))
    .reduce((sum, reservation) => sum + Math.max(0, reservation.amountUsd - (reservation.spentUsd ?? 0)), 0);
  return { spent, reserved, remaining: Math.max(0, automation.allowanceUsd - spent - reserved),
    unsettled: automation.reservations.some(reservation => ["submitted", "uncertain"].includes(reservation.status)) };
}
