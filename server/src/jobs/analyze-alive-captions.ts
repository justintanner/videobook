import type { Engine } from "videobook-engine";
import { analyzeAliveCaptions } from "../alive-captions/analyze.js";
import type { AliveAnalysis } from "../remotion/subtitles/alive-types.js";
import { registerJobHandler } from "../queue.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 600_000;

type AnalyzeAliveCaptionsPayload = {
  type: "analyze_alive_captions";
  assetId: string;
  assetDir: string;
  bookId: string;
  force?: boolean;
};

export interface AnalyzeAliveCaptionsResult {
  analysis: AliveAnalysis;
}

export function registerAnalyzeAliveCaptionsJob(engine: Engine): void {
  registerJobHandler("analyze_alive_captions", async (payload, ctx) => {
    const { assetId, assetDir, force = false } = payload as AnalyzeAliveCaptionsPayload;
    return withLockedLocalLease(
      engine,
      assetId,
      assetDir,
      ctx,
      "analyze",
      { durationMs: LOCK_DURATION_MS, data: { state: "analyzing-alive-captions" } },
      async () => ({ analysis: await analyzeAliveCaptions(engine, assetId, ctx.signal, force) }) satisfies AnalyzeAliveCaptionsResult,
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );
  });
}
