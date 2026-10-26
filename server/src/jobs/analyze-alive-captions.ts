import type { Engine } from "videobook-engine";
import { prepareCaptionAnalysis } from "../captions/analysis.js";
import { registerJobHandler } from "../queue.js";

type LegacyAnalyzeAliveCaptionsPayload = {
  assetId: string;
  bookId: string;
  force?: boolean;
};

export function registerAnalyzeAliveCaptionsJob(engine: Engine): void {
  registerJobHandler("analyze_alive_captions", async (payload) => {
    const { assetId, bookId, force = false } = payload as LegacyAnalyzeAliveCaptionsPayload;
    const prepared = await prepareCaptionAnalysis(engine, bookId, assetId, {
      regions: true,
      languages: [],
      force: force ? ["vocal", "regions"] : [],
    });
    return { assetId, transcript: prepared.state.transcript.status, vocal: prepared.state.vocal?.status ?? null };
  });
}
