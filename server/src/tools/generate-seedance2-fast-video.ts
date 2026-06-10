import type { VideocityFs } from "videocity-engine";
import type { ToolDef } from "./tool-def.js";
import { buildSeedance2ToolDef } from "./_seedance2-shared.js";

export function generateSeedance2FastVideoDef(fs: VideocityFs): ToolDef {
  return buildSeedance2ToolDef(fs, {
    toolName: "generate_seedance2_fast_video",
    description: "Generate a video using ByteDance Seedance 2 Fast (KIE). Supports text-only, first/last frame, and reference images/videos/audio. Up to 720p. Creates a new vid- asset and enqueues a background job.",
    apiModel: "bytedance/seedance-2-fast",
    resolutions: ["480p", "720p"],
  });
}
