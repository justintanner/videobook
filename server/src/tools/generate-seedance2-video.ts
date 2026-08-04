import type { Engine } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";
import { buildSeedance2ToolDef } from "./_seedance2-shared.js";

export function generateSeedance2VideoDef(fs: Engine): ToolDef {
  return buildSeedance2ToolDef(fs, {
    toolName: "generate_kie_seedance_2_0_video",
    jobType: "generate_seedance2_video",
    description: "Generate a video using ByteDance Seedance 2 (KIE). Supports text-only, first/last frame, and reference images/videos/audio. Up to 1080p. Creates a new video artifact and enqueues a background job.",
    apiModel: "bytedance/seedance-2",
  });
}
