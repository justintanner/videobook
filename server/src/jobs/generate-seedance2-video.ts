import type { Engine } from "videobook-engine";
import { registerSeedance2Job } from "./_seedance2-shared.js";

export function registerGenerateSeedance2VideoJob(engine: Engine): void {
  registerSeedance2Job(engine, "generate_seedance2_video");
}
