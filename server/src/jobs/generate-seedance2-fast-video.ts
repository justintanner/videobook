import type { VideocityFs } from "videobook-engine";
import { registerSeedance2Job } from "./_seedance2-shared.js";

export function registerGenerateSeedance2FastVideoJob(fs: VideocityFs): void {
  registerSeedance2Job(fs, "generate_seedance2_fast_video");
}
