import type { ClipfirstFs } from "clipfirst-engine";
import { registerSeedance2Job } from "./_seedance2-shared.js";

export function registerGenerateSeedance2VideoJob(fs: ClipfirstFs): void {
  registerSeedance2Job(fs, "generate_seedance2_video");
}
