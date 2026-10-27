import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { computeEstimate, type CostHints } from "@apicity/cost";
import { MACHGEN_VIDEO_GRIDS, MACHGEN_VIDEO_MODEL_TASK_TYPES, MachGenGenerateRequestSchema } from "@apicity/machgen";
import type { Engine } from "videobook-engine";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { pauseBookQueueForTests, resumeBookQueueForTests, waitForJob } from "../queue.js";
import { runFfmpeg } from "../ffmpeg.js";
import { pollPendingProviderTasks } from "../tools/reconcile-project-work.js";
import { readProviderTaskStatus } from "../provider-task-status.js";
import { MODEL_ENTRIES } from "./catalog.js";
import { resolveModel } from "./descriptor.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import { estimateGeneration } from "./cost.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import { configureProviderEndpoints } from "./endpoints.js";
import { sourcedGenerationInput } from "./generation-source.js";
import { MACHGEN_MODELS, machgenTaskUrl } from "./machgen.js";
import { previewGeneration } from "./preview.js";
import type { Operation } from "./types.js";
import { testBudget } from "../test-budget.js";

const FRAME = "https://example.test/first.png";
const LAST = "https://example.test/last.png";
const CLIP = "https://example.test/clip.mp4";
const SONG = "https://example.test/song.mp3";
const UPSCALE = "machgen:MiniMax-H3/upscale";

const OPERATION_BY_TASK: Record<string, Operation> = {
  T2V: "text_to_video",
  I2V: "image_to_video",
  R2V: "reference_to_video",
};

const HIDDEN = ["Vidu-Q3", "Vidu-Q3-Pro", "Vidu-Q3-Pro-Fast", "Vidu-Q3-Turbo", "Vidu-Q4-Preview", "Wan2.2-A14B"];

function request(id: string, call: WireRequestInput): Record<string, unknown> {
  const built = buildWireRequest(resolveModel(id), call);
  if (!built.ok) throw new Error(built.error);
  return built.request;
}

function options(id: string): Record<string, { enumValues: Array<string | number>; minimum?: number; maximum?: number; defaultValue?: unknown; valueType: string }> {
  return Object.fromEntries(resolveModel(id).options.map((option) => [option.name, option]));
}

describe("MachGen catalog", () => {
  it("catalogs every MachGen generation model apicity publishes and hides the ones MachGen keeps out of its picker", () => {
    const published: Record<string, readonly string[]> = MACHGEN_VIDEO_MODEL_TASK_TYPES;
    expect(Object.keys(published).filter((apiId) => !(apiId in MACHGEN_MODELS)).sort()).toEqual([
      "Topaz-Video-Generative", "Topaz-Video-Generative-Fast", "Topaz-Video-Precision", "Topaz-Video-Precision-Animation",
    ]);
    for (const apiId of Object.keys(MACHGEN_MODELS)) {
      const tasks = (published[apiId] ?? []).filter((task) => task !== "UPSCALE");
      const model = resolveModel(`machgen:${apiId}`);
      expect(model).toMatchObject({ provider: "machgen", apiId, media: "video" });
      expect(model.title).toMatch(/\(MachGen\)$/u);
      expect(model.entry.hidden ?? false, apiId).toBe(HIDDEN.includes(apiId));
      expect(model.entry.operations).toEqual(tasks.map((task) => OPERATION_BY_TASK[task]));
      expect(MACHGEN_MODELS[apiId]!.taskTypes).toEqual(tasks);
      for (const task of tasks) expect(MACHGEN_VIDEO_GRIDS[apiId]?.[task as "T2V" | "I2V" | "R2V"], `${apiId} ${task}`).toBeDefined();
    }
    expect(MODEL_ENTRIES.filter((entry) => entry.id.startsWith("machgen:")).map((entry) => entry.id.slice("machgen:".length)).sort())
      .toEqual([...Object.keys(MACHGEN_MODELS), "MiniMax-H3/upscale"].sort());
  });

  it("takes the frame and reference inputs each model's MachGen grids accept", () => {
    const caps = { image: "images", video: "videos", audio: "audios" } as const;
    for (const [apiId, spec] of Object.entries(MACHGEN_MODELS)) {
      const model = resolveModel(`machgen:${apiId}`);
      const grids = MACHGEN_VIDEO_GRIDS[apiId]!;
      const roles = model.slots.map((slot) => slot.role);
      expect(roles.includes("first_frame"), apiId).toBe(grids.I2V !== undefined);
      expect(roles.includes("last_frame"), apiId).toBe(grids.I2V?.endFrame === true);
      if (grids.I2V?.loneEndFrame) expect(model.modes.find((mode) => mode.id === "i2v")?.requireAny).toEqual(["first_frame", "last_frame"]);
      expect(model.modes.find((mode) => mode.id === "r2v")?.roles ?? [], apiId).toEqual(spec.references);
      for (const kind of spec.references) {
        const cap = grids.R2V?.references?.[caps[kind]];
        expect(model.slots.find((slot) => slot.role === kind)?.max, `${apiId} ${kind}`).toBe(cap ?? (kind === "image" ? 9 : 3));
      }
    }
  });

  it("offers each model's resolutions, durations and defaults as options", () => {
    expect(options("machgen:MiniMax-H3")).toMatchObject({
      resolution: { enumValues: ["480p", "768p", "1440p"], defaultValue: "1440p" },
      duration: { minimum: 1, maximum: 30, defaultValue: 12 },
      aspect_ratio: { enumValues: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], defaultValue: "9:16" },
      generate_audio: { valueType: "boolean", defaultValue: true },
      seed: { valueType: "integer" },
    });
    expect(options("machgen:MiniMax-H3-Turbo")).toMatchObject({
      resolution: { enumValues: ["480p", "768p"], defaultValue: "768p" },
      duration: { minimum: 4, maximum: 15, defaultValue: 12 },
    });
    expect(options("machgen:Seedance-2.5").aspect_ratio).toMatchObject({ defaultValue: "9:16" });
    expect(options("machgen:Seedance-2.5").seed).toBeUndefined();
    expect(options("machgen:Seedance-2.0").resolution).toMatchObject({ enumValues: ["480p", "720p", "1080p", "2160p"] });
    expect(options("machgen:Seedance-2.0-Mini").resolution).toMatchObject({ enumValues: ["480p", "720p"], defaultValue: "720p" });
    expect(Object.keys(options("machgen:Alibaba-Wan-3.0")).sort()).toEqual(["duration", "resolution", "seed"]);
    expect(options("machgen:HappyHorse-1.1")).toMatchObject({ resolution: { enumValues: ["720p", "1080p"] }, duration: { minimum: 3, maximum: 15 } });
    expect(Object.keys(options("machgen:Grok-Imagine-Video-1.5")).sort()).toEqual(["duration", "resolution"]);
    expect(resolveModel("machgen:Grok-Imagine-Video-1.5").slots).toEqual([expect.objectContaining({ role: "first_frame", min: 1, max: 1 })]);
    expect(options("machgen:LTX-2.3-Pro")).toMatchObject({
      duration: { enumValues: [6, 8, 10], defaultValue: 10 },
      resolution: { enumValues: ["1080p", "1440p", "2160p"], defaultValue: "2160p" },
      aspect_ratio: { enumValues: ["16:9"], defaultValue: "16:9" },
    });
    expect(options("machgen:Veo-3.1")).toMatchObject({
      duration: { enumValues: [4, 6, 8], defaultValue: 8 },
      aspect_ratio: { enumValues: ["16:9", "9:16"], defaultValue: "9:16" },
    });
    expect(Object.keys(options("machgen:Veo-3.1")).sort()).toEqual(["aspect_ratio", "duration", "resolution", "seed"]);
    expect(options("machgen:Wan2.2-A14B")).toMatchObject({ duration: { enumValues: [5], defaultValue: 5 }, resolution: { enumValues: ["480p", "720p"] } });
    expect(Object.keys(options("machgen:Kling-v3")).sort()).toEqual(["aspect_ratio", "duration", "generate_audio", "resolution"]);
    expect(Object.keys(options("machgen:Kling-o3")).sort()).toEqual(["aspect_ratio", "duration", "generate_audio", "multi_prompt", "resolution", "shot_durations", "shot_type"]);
    expect(options("machgen:Kling-o3").shot_type).toMatchObject({ enumValues: ["intelligence", "customize"] });
    expect(options("machgen:Vidu-Q4-Preview").aspect_ratio).toMatchObject({ enumValues: ["16:9", "9:16", "1:1", "4:3", "3:4"] });
    expect(options("machgen:Pixverse-C1").resolution).toMatchObject({ enumValues: ["360p", "540p", "720p", "1080p"] });
    expect(Object.keys(options("machgen:Grok-Imagine-Video")).sort()).toEqual(["aspect_ratio", "duration", "resolution"]);
    expect(Object.keys(options(UPSCALE))).toEqual([]);
    expect(resolveModel(UPSCALE).slots).toEqual([expect.objectContaining({ role: "video", min: 1, max: 1 })]);
  });

  it("builds a request MachGen's schema accepts and prices for every offered combination the input guards let through", () => {
    const refused: Record<string, number> = {};
    const failures: string[] = [];
    let accepted = 0;
    for (const apiId of Object.keys(MACHGEN_MODELS)) {
      const model = resolveModel(`machgen:${apiId}`);
      const settings = options(`machgen:${apiId}`);
      for (const variant of sweepVariants(apiId)) {
        for (const resolution of settings.resolution!.enumValues) {
          for (const aspect of settings.aspect_ratio?.enumValues ?? [undefined]) {
            for (const duration of MACHGEN_MODELS[apiId]!.durations) {
              for (const audio of settings.generate_audio ? [true, false] : [undefined]) {
                const value = {
                  prompt: "a red boat drifts",
                  ...variant.fields,
                  resolution,
                  duration,
                  ...(aspect === undefined ? {} : { aspect_ratio: aspect }),
                  ...(audio === undefined ? {} : { generate_audio: audio }),
                };
                const input = model.wire.input.safeParse(value);
                if (!input.success) {
                  refused[apiId] = (refused[apiId] ?? 0) + 1;
                  continue;
                }
                const parsed = MachGenGenerateRequestSchema.safeParse(model.wire.wrap(input.data as Record<string, unknown>));
                if (!parsed.success) {
                  failures.push(`${apiId} ${JSON.stringify(value)}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
                  continue;
                }
                accepted += 1;
                if (duration === -1) continue;
                const estimate = computeEstimate({ provider: "machgen", payload: parsed.data as Record<string, unknown>, costHints: variant.hints });
                if (!(estimate.usd > 0) || estimate.warnings.length > 0) failures.push(`${apiId} ${JSON.stringify(value)} priced ${estimate.usd}: ${estimate.warnings.join("; ")}`);
              }
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
    expect(accepted).toBe(34_273);
    expect(refused).toEqual(EXPECTED_REFUSALS);
  });

  it.each([
    ["machgen:MiniMax-H3", { prompt: "a red boat" }, {
      model: "MiniMax-H3", task_type: "T2V", prompt: "a red boat",
      video_config: { height: 1440, duration_secs: 12, aspect_ratio: "9:16", audio: true },
    }],
    ["machgen:MiniMax-H3", { prompt: "end on the cat", refUrls: { last_frame: [LAST] }, options: { resolution: "480p", seed: 7 } }, {
      task_type: "I2V", seed: 7, src_image_urls: [LAST], keyframe_indices: [-1],
      video_config: { height: 480, duration_secs: 12, aspect_ratio: "9:16", audio: true },
    }],
    ["machgen:Seedance-2.5", { prompt: "the cat turns", refUrls: { first_frame: [FRAME], last_frame: [LAST] }, options: { aspect_ratio: "16:9", generate_audio: false } }, {
      model: "Seedance-2.5", task_type: "I2V", src_image_urls: [FRAME, LAST],
      video_config: { height: 1080, duration_secs: 12, aspect_ratio: "adaptive", audio: false },
    }],
    ["machgen:Seedance-2.0", { prompt: "dance", refUrls: { image: [FRAME], video: [CLIP], audio: [SONG] }, options: { duration: -1, resolution: "2160p" } }, {
      task_type: "R2V", src_image_urls: [FRAME], src_video_urls: [CLIP], src_audio_urls: [SONG],
      video_config: { height: 2160, duration_secs: -1, aspect_ratio: "9:16", audio: true },
    }],
    ["machgen:Alibaba-Wan-3.0", { prompt: "a slow pan", options: { duration: 2, resolution: "480p" } }, {
      model: "Alibaba-Wan-3.0", task_type: "T2V",
      video_config: { height: 480, duration_secs: 2, aspect_ratio: "adaptive", fps: 30, audio: true },
    }],
    ["machgen:HappyHorse-1.1", { prompt: "the cat blinks", refUrls: { first_frame: [FRAME] }, options: { resolution: "1080p", duration: 3 } }, {
      task_type: "I2V", src_image_urls: [FRAME], video_config: { height: 1080, duration_secs: 3 },
    }],
    ["machgen:Grok-Imagine-Video-1.5", { refUrls: { first_frame: [FRAME] }, options: { resolution: "480p", duration: 1 } }, {
      model: "Grok-Imagine-Video-1.5", task_type: "I2V", prompt: "", src_image_urls: [FRAME],
      video_config: { height: 480, duration_secs: 1 },
    }],
    ["machgen:MiniMax-H3-Turbo", { prompt: "a fast car", refUrls: { first_frame: [FRAME], last_frame: [LAST] } }, {
      model: "MiniMax-H3-Turbo", task_type: "I2V", src_image_urls: [FRAME, LAST],
      video_config: { height: 768, duration_secs: 12, aspect_ratio: "9:16", audio: true },
    }],
    ["machgen:Seedance-2.0-Fast", { prompt: "rally", refUrls: { first_frame: [FRAME] }, options: { aspect_ratio: "16:9" } }, {
      model: "Seedance-2.0-Fast", task_type: "I2V", src_image_urls: [FRAME],
      video_config: { height: 720, duration_secs: 12, aspect_ratio: "16:9", audio: true },
    }],
    ["machgen:LTX-2.3-Pro", { prompt: "a cinematic pan" }, {
      model: "LTX-2.3-Pro", task_type: "T2V", video_config: { height: 2160, duration_secs: 10, aspect_ratio: "16:9", audio: true },
    }],
    ["machgen:Kling-v3", { prompt: "the cat jumps", refUrls: { first_frame: [FRAME], last_frame: [LAST] }, options: { generate_audio: false } }, {
      model: "Kling-v3", task_type: "I2V", src_image_urls: [FRAME, LAST], video_config: { height: 2160, duration_secs: 12, audio: false },
    }],
    ["machgen:Kling-o3", {
      prompt: "a short story",
      refUrls: { image: [FRAME] },
      options: { duration: 9, shot_type: "customize", multi_prompt: ["the cat wakes", "the cat leaves"], shot_durations: [4, 5] },
    }, {
      model: "Kling-o3", task_type: "R2V", src_image_urls: [FRAME],
      video_config: {
        height: 2160, duration_secs: 9, aspect_ratio: "9:16", audio: true,
        shot_type: "customize", multi_prompt: ["the cat wakes", "the cat leaves"], shot_durations: [4, 5],
      },
    }],
    ["machgen:Kling-o3", { prompt: "a short story", options: { shot_type: "intelligence" } }, {
      task_type: "T2V", video_config: { height: 2160, duration_secs: 12, aspect_ratio: "9:16", audio: true, shot_type: "intelligence" },
    }],
    ["machgen:Veo-3.1", { prompt: "a lighthouse at dusk" }, {
      model: "Veo-3.1", task_type: "T2V", video_config: { height: 2160, duration_secs: 8, aspect_ratio: "9:16" },
    }],
    ["machgen:Vidu-Q3-Pro", { prompt: "the fox runs", refUrls: { image: [FRAME] } }, {
      model: "Vidu-Q3-Pro", task_type: "R2V", src_image_urls: [FRAME], video_config: { height: 720, duration_secs: 12, aspect_ratio: "9:16", audio: true },
    }],
    ["machgen:Vidu-Q3-Pro", { prompt: "the fox runs" }, {
      task_type: "T2V", video_config: { height: 1080, duration_secs: 12, aspect_ratio: "9:16", audio: true },
    }],
    ["machgen:Vidu-Q4-Preview", { prompt: "a duet", refUrls: { image: [FRAME], audio: [SONG] } }, {
      model: "Vidu-Q4-Preview", task_type: "R2V", src_image_urls: [FRAME], src_audio_urls: [SONG],
      video_config: { height: 2160, duration_secs: 12, aspect_ratio: "9:16", audio: true },
    }],
    ["machgen:Pixverse-V6", { prompt: "a neon street", refUrls: { first_frame: [FRAME] }, options: { resolution: "360p" } }, {
      model: "Pixverse-V6", task_type: "I2V", src_image_urls: [FRAME], video_config: { height: 360, duration_secs: 12, audio: true },
    }],
    ["machgen:Wan2.2-A14B", { prompt: "a quick draft" }, {
      model: "Wan2.2-A14B", task_type: "T2V", video_config: { height: 720, duration_secs: 5, aspect_ratio: "16:9" },
    }],
  ] as const)("%s builds the documented MachGen request", (id, call, expected) => {
    const built = request(id, call as WireRequestInput);
    expect(built).toMatchObject(expected);
    if (!("keyframe_indices" in expected)) expect(built).not.toHaveProperty("keyframe_indices");
    if (id === "machgen:HappyHorse-1.1" || id === "machgen:Kling-v3" || id === "machgen:Pixverse-V6") {
      expect(built.video_config).not.toHaveProperty("aspect_ratio");
    }
  });

  it.each([
    ["machgen:Seedance-2.5", { prompt: "x", refUrls: { first_frame: [FRAME], image: [LAST] } }, /Reference image urls: cannot be combined with first_frame_url/],
    ["machgen:Seedance-2.5", { prompt: "x", refUrls: { last_frame: [LAST] } }, /last_frame_url requires first_frame_url/],
    ["machgen:MiniMax-H3", { prompt: "x", refUrls: { first_frame: [FRAME], last_frame: [LAST] }, options: { duration: 16 } }, /Duration: a first and last frame allow at most 15 seconds/],
    ["machgen:MiniMax-H3", { prompt: "x", options: { resolution: "1440p", duration: 16 } }, /Duration: 1440p allows at most 15 seconds/],
    ["machgen:MiniMax-H3", { refUrls: { first_frame: [FRAME] } }, /requires a prompt/],
    ["machgen:Seedance-2.5", { prompt: "x", refUrls: { video: [CLIP] }, options: { duration: -1, aspect_ratio: "16:9" } }, /Aspect ratio: -1 duration with a reference video/],
    ["machgen:Seedance-2.0", { prompt: "x", refUrls: { audio: [SONG] } }, /needs at least one reference image or video/],
    ["machgen:Seedance-2.0", {}, /Prompt: Required/],
    ["machgen:Seedance-2.0", { prompt: "x", options: { duration: 16 } }, /Duration:/],
    ["machgen:Alibaba-Wan-3.0", { prompt: "x", options: { aspect_ratio: "16:9" } }, /not an option of machgen:Alibaba-Wan-3.0/],
    ["machgen:HappyHorse-1.1", { prompt: "x", refUrls: { video: [CLIP] } }, /does not accept video refs/],
    ["machgen:Grok-Imagine-Video-1.5", { prompt: "x" }, /requires at least 1 first_frame ref/],
    ["machgen:Vidu-Q3-Pro", { prompt: "x", refUrls: { image: [FRAME] }, options: { resolution: "1080p" } }, /Resolution: Reference to video offers 540p, 720p/],
    ["machgen:Vidu-Q3", { prompt: "x" }, /needs one of: image/],
    ["machgen:Vidu-Q4-Preview", { prompt: "x", refUrls: { audio: [SONG] } }, /needs at least one reference image$/],
    ["machgen:Vidu-Q4-Preview", { refUrls: { image: [FRAME] } }, /Prompt: Required/],
    ["machgen:Kling-o3", { prompt: "x", refUrls: { image: Array.from({ length: 8 }, () => FRAME) } }, /accepts at most 7 image refs/],
    ["machgen:Kling-o3", { prompt: "x", options: { shot_type: "customize" } }, /Multi prompt: Required with shot_type customize/],
    ["machgen:Kling-o3", { prompt: "x", options: { shot_type: "customize", multi_prompt: ["a", "b"], shot_durations: [4] } }, /Shot durations: needs one entry for each of the 2 shots/],
    ["machgen:Kling-o3", { prompt: "x", options: { duration: 12, shot_type: "customize", multi_prompt: ["a", "b"], shot_durations: [4, 5] } }, /Shot durations: add up to 9 seconds; set duration to 9/],
    ["machgen:Kling-o3", { prompt: "x", options: { multi_prompt: ["a"] } }, /Shot type: multi_prompt and shot_durations need shot_type customize/],
    ["machgen:Seedance-2.0-Mini", { prompt: "x", refUrls: { image: Array.from({ length: 9 }, () => FRAME), video: [CLIP, CLIP], audio: [SONG, SONG] } }, /at most 12 references in all/],
    ["machgen:Seedance-2.0-Mini", { refUrls: { first_frame: [FRAME] } }, /requires a prompt/],
    ["machgen:Veo-3.1", { prompt: "x", options: { duration: 5 } }, /Duration:/],
    ["machgen:Veo-3.1", { prompt: "x", options: { generate_audio: false } }, /not an option of machgen:Veo-3.1/],
    ["machgen:MiniMax-H3-Turbo", { prompt: "x", options: { resolution: "1080p" } }, /Resolution:/],
    [UPSCALE, { refUrls: { video: [CLIP] } }, /Video url: connect a video from this book; MachGen re-renders only its own MiniMax-H3 768p videos of 5-15 s/],
    [UPSCALE, { refUrls: { video: [machgenTaskUrl("task-1", 20)] } }, /Video url: the source is 20 s/],
  ] as const)("%s rejects a request MachGen would refuse", (id, call, error) => {
    const built = buildWireRequest(resolveModel(id), call as WireRequestInput);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toMatch(error);
  });

  it.each([
    ["machgen:MiniMax-H3", { prompt: "x", options: { resolution: "768p", duration: 5 } }, {}, 0.2],
    ["machgen:MiniMax-H3", { prompt: "x", options: { resolution: "480p", duration: 20 } }, {}, 0.6125],
    ["machgen:MiniMax-H3", { prompt: "x", refUrls: { video: [CLIP] }, options: { resolution: "768p", duration: 5 } }, { inputDurationSeconds: 4 }, 0.54],
    ["machgen:Seedance-2.5", { prompt: "x", options: { resolution: "720p", duration: 5 } }, {}, 1.15],
    ["machgen:Seedance-2.5", { prompt: "x", refUrls: { video: [CLIP] }, options: { resolution: "720p", duration: 5 } }, { inputDurationSeconds: 4 }, 1.26],
    ["machgen:Seedance-2.0", { prompt: "x", options: { resolution: "2160p", duration: 5 } }, {}, 3.9],
    ["machgen:Alibaba-Wan-3.0", { prompt: "x", options: { resolution: "1080p", duration: 10 } }, {}, 1.91],
    ["machgen:HappyHorse-1.1", { prompt: "x", options: { resolution: "1080p", duration: 5 } }, {}, 0.85],
    ["machgen:Grok-Imagine-Video-1.5", { refUrls: { first_frame: [FRAME] }, options: { resolution: "480p", duration: 5 } }, {}, 0.475],
    ["machgen:MiniMax-H3-Turbo", { prompt: "x", options: { resolution: "768p", duration: 10 } }, {}, 0.1],
    ["machgen:Seedance-2.0-Fast", { prompt: "x", options: { resolution: "720p", duration: 5 } }, {}, 0.6],
    ["machgen:Seedance-2.0-Fast", { prompt: "x", refUrls: { video: [CLIP] }, options: { resolution: "720p", duration: 5 } }, { inputDurationSeconds: 4 }, 0.63],
    ["machgen:Seedance-2.0-Mini", { prompt: "x", options: { resolution: "480p", duration: 5 } }, {}, 0.165],
    ["machgen:LTX-2.3-Pro", { prompt: "x", options: { resolution: "2160p", duration: 10 } }, {}, 1],
    ["machgen:Kling-v3", { prompt: "x", options: { resolution: "1080p", duration: 5 } }, {}, 0.795],
    ["machgen:Kling-v3", { prompt: "x", options: { resolution: "1080p", duration: 5, generate_audio: false } }, {}, 0.53],
    ["machgen:Kling-o3", { prompt: "x", refUrls: { image: [FRAME] }, options: { resolution: "720p", duration: 10 } }, {}, 1.06],
    ["machgen:Veo-3.1", { prompt: "x", options: { resolution: "1080p", duration: 8 } }, {}, 3.768],
    ["machgen:Veo-3.1-Fast", { prompt: "x", options: { resolution: "720p", duration: 4 } }, {}, 0.472],
    ["machgen:Pixverse-V6", { prompt: "x", options: { resolution: "1080p", duration: 5 } }, {}, 0.545],
    ["machgen:Pixverse-C1", { prompt: "x", options: { resolution: "360p", duration: 5, generate_audio: false } }, {}, 0.145],
    ["machgen:HappyHorse-1.0", { prompt: "x", options: { resolution: "1080p", duration: 5 } }, {}, 1.32],
    ["machgen:Grok-Imagine-Video", { prompt: "x", options: { resolution: "720p", duration: 5 } }, {}, 0.415],
    ["machgen:Wan2.2-A14B", { prompt: "x", options: { resolution: "720p" } }, {}, 0.18],
    ["machgen:Vidu-Q3-Turbo", { prompt: "x", options: { resolution: "540p", duration: 10 } }, {}, 0.165],
    ["machgen:Vidu-Q3-Pro", { prompt: "x", options: { resolution: "1080p", duration: 5 } }, {}, 0.71],
    ["machgen:Vidu-Q3", { prompt: "x", refUrls: { image: [FRAME] }, options: { resolution: "720p", duration: 5 } }, {}, 0.355],
    ["machgen:Vidu-Q3-Pro-Fast", { refUrls: { first_frame: [FRAME] }, options: { resolution: "1080p", duration: 5 } }, {}, 0.74],
    ["machgen:Vidu-Q4-Preview", { refUrls: { first_frame: [FRAME] }, options: { resolution: "2160p", duration: 5 } }, {}, 1.95],
    [UPSCALE, { refUrls: { video: [machgenTaskUrl("task-1", 10)] } }, { inputDurationSeconds: 10 }, 1],
  ] as const)("%s is priced from the @apicity/cost machgen rows", async (id, call, hints, usd) => {
    const result = await estimateGeneration(resolveModel(id), call as WireRequestInput, hints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.estimate.usd).toBeCloseTo(usd, 6);
    expect(result.estimate.warnings).toEqual([]);
  });

  it("explains a -1 duration estimate MachGen bills by the generated length", async () => {
    const result = await estimateGeneration(resolveModel("machgen:Seedance-2.5"), { prompt: "x", options: { duration: -1 } });
    expect(result.ok && result.estimate).toMatchObject({ usd: 0, warnings: [expect.stringContaining("duration_secs -1")] });
  });

  it("names references in plain words and drops frame mentions", () => {
    const refs = {
      first_frame: ["11111111-1111-4111-8111-111111111111"],
      image: ["22222222-2222-4222-8222-222222222222"],
      audio: ["33333333-3333-4333-8333-333333333333"],
    };
    expect(applyPromptDialect("natural_strip_frames", "Open on @firstframe, then @image1 dances to @audio1", refs))
      .toBe("Open on, then reference image 1 dances to reference audio 1");
  });
});

const EXPECTED_REFUSALS: Record<string, number> = { "MiniMax-H3": 1620, "Seedance-2.5": 36, "Vidu-Q3-Pro": 128 };

type SweepVariant = { fields: Record<string, unknown>; hints: CostHints };

function sweepVariants(apiId: string): SweepVariant[] {
  const spec = MACHGEN_MODELS[apiId]!;
  const accepts = (kind: "image" | "video" | "audio") => spec.references.includes(kind);
  return [
    ...(spec.taskTypes.includes("T2V") ? [{ fields: {}, hints: {} }] : []),
    ...(spec.taskTypes.includes("I2V") ? [
      { fields: { first_frame_url: FRAME }, hints: {} },
      ...(spec.lastFrame === "none" ? [] : [{ fields: { first_frame_url: FRAME, last_frame_url: LAST }, hints: {} }]),
      ...(spec.lastFrame === "alone" ? [{ fields: { last_frame_url: LAST }, hints: {} }] : []),
    ] : []),
    ...(spec.taskTypes.includes("R2V") ? [
      ...(accepts("image") ? [{ fields: { reference_image_urls: [FRAME] }, hints: {} }] : []),
      ...(accepts("video") ? [{ fields: { reference_video_urls: [CLIP] }, hints: { inputDurationSeconds: 4 } }] : []),
      ...(accepts("audio") ? [{ fields: { reference_image_urls: [FRAME], reference_audio_urls: [SONG] }, hints: {} }] : []),
    ] : []),
  ];
}

type Recorded = { method: string; path: string; authorization: string | undefined; body: string };

function readBody(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => resolve(Buffer.concat(chunks).toString()));
    incoming.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

describe("MachGen provider tasks", () => {
  const TASK_ID = "a7b3c9d1-0000-4000-8000-000000000001";
  const UPSCALE_TASK_ID = "a7b3c9d1-0000-4000-8000-000000000002";
  let fixtures: string;
  let mp4: Buffer;
  let server: Server;
  let baseURL: string;
  let recorded: Recorded[];
  let taskIds: string[];
  let taskStatus: { code: number; body: Record<string, unknown> };
  let root: string;
  let engine: Engine;
  let client: Client;
  let restoreEndpoints: () => void;
  let originalKey: string | undefined;

  function route(method: string, path: string, response: ServerResponse): void {
    if (method === "POST" && path === "/api/v0/generate") {
      return sendJson(response, 200, { task_id: taskIds.shift() ?? TASK_ID, metadata: { model: "Seedance-2.5", task_type: "I2V" }, task_output: null, moderation: null });
    }
    if (method === "GET" && path.startsWith("/api/v0/tasks/")) return sendJson(response, taskStatus.code, taskStatus.body);
    if (method === "GET" && path.startsWith("/api/v0/assets/")) {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end(mp4);
      return;
    }
    sendJson(response, 404, { detail: "Not Found" });
  }

  function status(state: string, extra: Record<string, unknown> = {}): { code: number; body: Record<string, unknown> } {
    return { code: 200, body: { task_id: TASK_ID, metadata: { model: "Seedance-2.5" }, task_output: null, status: state, error_msg: null, ...extra } };
  }

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-machgen-fixtures-"));
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-pix_fmt", "yuv420p", join(fixtures, "clip.mp4")]);
    mp4 = await readFile(join(fixtures, "clip.mp4"));
    server = createServer((incoming, response) => {
      void readBody(incoming).then((body) => {
        const authorization = incoming.headers.authorization;
        recorded.push({ method: incoming.method ?? "", path: incoming.url ?? "", authorization, body });
        route(incoming.method ?? "", incoming.url ?? "", response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixtures, { recursive: true, force: true });
  });

  beforeEach(async () => {
    recorded = [];
    taskIds = [];
    taskStatus = status("RUNNING");
    root = await mkdtemp(join(tmpdir(), "videobook-machgen-"));
    engine = createEngineForTest(root);
    client = await createTestClient(root);
    await pauseBookQueueForTests(engine.book.get().bookId);
    originalKey = process.env.MACHGEN_API_KEY;
    process.env.MACHGEN_API_KEY = "local-machgen-key";
    restoreEndpoints = configureProviderEndpoints({ machgenBaseURL: baseURL });
  });

  afterEach(async () => {
    restoreEndpoints();
    await client.close();
    if (originalKey === undefined) delete process.env.MACHGEN_API_KEY;
    else process.env.MACHGEN_API_KEY = originalKey;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
    return (result.content as Array<{ text: string }>)[0]!.text;
  }

  async function generated(args: Record<string, unknown>): Promise<string> {
    const bookId = engine.book.get().bookId;
    const result = await client.callTool({ name: "generate_video", arguments: { book_id: bookId, ...args } });
    expect(result.isError, toolText(result)).toBeFalsy();
    const enqueued = JSON.parse(toolText(result)) as { asset_id: string; job_id: string };
    await resumeBookQueueForTests(bookId);
    await waitForJob(enqueued.job_id, testBudget(30_000));
    return enqueued.asset_id;
  }

  function submitted(): Promise<string> {
    return generated({ model: "machgen:Seedance-2.5", prompt: "the cat blinks", refs: { first_frame: [FRAME] } });
  }

  async function completeTasks(): Promise<void> {
    taskStatus = status("COMPLETED", { task_output: { video: `${baseURL}/api/v0/assets/${TASK_ID}` } });
    const done = await pollPendingProviderTasks(engine, engine.book.get().bookId);
    expect(done.failed).toEqual([]);
    for (const completed of done.completed) await waitForJob(completed.jobId, testBudget(30_000));
  }

  async function seededVideo(payload: Record<string, unknown> | null): Promise<string> {
    const created = await engine.artifacts.create({ kind: "video", label: "source" });
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    const written = await engine.files.write(artifactId, "original.mp4", mp4);
    if (!written.ok) throw new Error(written.error.message);
    if (payload) {
      await engine.metadata.artifacts.write(artifactId, "generation-payload", payload);
      await engine.metadata.artifacts.write(artifactId, "provider-task", { taskId: "seeded-task", taskType: "machgen_media", createdAt: Date.now(), meta: {} });
    }
    return artifactId;
  }

  function h3Payload(height: number, seconds: number): Record<string, unknown> {
    return { model: "MiniMax-H3", task_type: "T2V", prompt: "a red boat", video_config: { height, duration_secs: seconds, aspect_ratio: "9:16", audio: true } };
  }

  it("submits, polls and downloads a MachGen video with the API key", async () => {
    const assetId = await submitted();
    const generate = recorded.find((entry) => entry.path === "/api/v0/generate")!;
    expect(generate.authorization).toBe("Bearer local-machgen-key");
    expect(JSON.parse(generate.body)).toEqual({
      model: "Seedance-2.5",
      task_type: "I2V",
      prompt: "the cat blinks",
      video_config: { height: 1080, duration_secs: 12, aspect_ratio: "adaptive", audio: true },
      src_image_urls: [FRAME],
    });
    const pending = engine.jobs.pending.read(assetId);
    expect(pending.ok && pending.value).toMatchObject({
      taskId: TASK_ID,
      taskType: "machgen_media",
      meta: { model: "machgen:Seedance-2.5", media: "video", machgenModel: "Seedance-2.5" },
    });
    const hints = await engine.metadata.artifacts.read(assetId, "generation-cost-hints");
    expect(hints.ok && hints.value).toEqual({ durationSeconds: 12 });
    expect(engine.usage.recent(10).find((entry) => entry.artifactId === assetId)).toMatchObject({
      provider: "machgen", model: "Seedance-2.5", activity: "video", status: "pending",
      externalId: TASK_ID, basis: "estimated", costUsd: expect.closeTo(7.08, 6), warnings: [],
    });
    expect(await readProviderTaskStatus(engine, assetId)).toEqual({ provider: "machgen", model: "Seedance-2.5", taskId: TASK_ID });

    const bookId = engine.book.get().bookId;
    const running = await pollPendingProviderTasks(engine, bookId);
    expect(running.pending).toEqual([expect.objectContaining({ assetId, taskType: "machgen_media", state: "running" })]);
    expect(running.completed).toEqual([]);

    taskStatus = status("COMPLETED", { task_output: { video: `${baseURL}/api/v0/assets/${TASK_ID}` } });
    const done = await pollPendingProviderTasks(engine, bookId);
    expect(done.failed).toEqual([]);
    expect(done.completed).toEqual([expect.objectContaining({ assetId, taskType: "machgen_media" })]);
    await waitForJob(done.completed[0]!.jobId, testBudget(30_000));

    const download = recorded.find((entry) => entry.path === `/api/v0/assets/${TASK_ID}`);
    expect(download?.authorization).toBe("Bearer local-machgen-key");
    const manifest = await engine.files.manifest(assetId);
    expect(manifest.ok && manifest.value.files.map((file) => file.name)).toContain("original.mp4");
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: null });
    expect(engine.usage.recent(10).find((entry) => entry.artifactId === assetId)).toMatchObject({ status: "completed" });
  });

  it("fails a MachGen task the provider reports as failed", async () => {
    const assetId = await submitted();
    taskStatus = status("FAILED", { error_msg: "Request Rejected" });
    const polled = await pollPendingProviderTasks(engine, engine.book.get().bookId);
    expect(polled.failed).toEqual([expect.objectContaining({ assetId, failMsg: "Request Rejected" })]);
    const failure = engine.jobs.failures.read(assetId);
    expect(failure.ok && failure.value?.message).toBe("Request Rejected");
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: null });
  });

  it("keeps polling through MachGen rate limits but fails a task MachGen no longer knows", async () => {
    const assetId = await submitted();
    const bookId = engine.book.get().bookId;
    taskStatus = { code: 429, body: { detail: "Too Many Requests" } };
    const limited = await pollPendingProviderTasks(engine, bookId);
    expect(limited.failed).toEqual([expect.objectContaining({ assetId, failMsg: "MachGen API error 429: Too Many Requests" })]);
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: expect.objectContaining({ taskId: TASK_ID }) });
    expect(engine.jobs.failures.read(assetId)).toMatchObject({ ok: true, value: null });

    taskStatus = { code: 404, body: { detail: "Task not found" } };
    await pollPendingProviderTasks(engine, bookId);
    const failure = engine.jobs.failures.read(assetId);
    expect(failure.ok && failure.value?.message).toBe("MachGen API error 404: Task not found");
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: null });
  });

  it("refuses MachGen generation without MACHGEN_API_KEY and leaves its tasks unpolled", async () => {
    const assetId = await submitted();
    recorded = [];
    delete process.env.MACHGEN_API_KEY;
    const before = engine.artifacts.list().length;
    const refused = await client.callTool({
      name: "generate_video",
      arguments: { book_id: engine.book.get().bookId, model: "machgen:MiniMax-H3", prompt: "a red boat" },
    });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toBe("MACHGEN_API_KEY environment variable is not set");
    expect(engine.artifacts.list()).toHaveLength(before);

    const polled = await pollPendingProviderTasks(engine, engine.book.get().bookId);
    expect(polled).toEqual({ pending: [], completed: [], failed: [] });
    expect(recorded).toEqual([]);
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: expect.objectContaining({ taskId: TASK_ID }) });
  });

  it("re-renders a MachGen MiniMax H3 768p video at 1440p from its task id", async () => {
    const bookId = engine.book.get().bookId;
    taskIds = [TASK_ID, UPSCALE_TASK_ID];
    const sourceId = await generated({ model: "machgen:MiniMax-H3", prompt: "a red boat", options: { resolution: "768p", duration: 10 } });
    await completeTasks();
    await pauseBookQueueForTests(bookId);
    recorded = [];

    const estimate = await client.callTool({
      name: "estimate_cost",
      arguments: { calls: [{ tool_name: "generate_video", input: { book_id: bookId, model: UPSCALE, refs: { video: [sourceId] } } }] },
    });
    expect(estimate.isError, toolText(estimate)).toBeFalsy();
    expect(JSON.parse(toolText(estimate))).toMatchObject({ estimate: { usd: expect.closeTo(1, 6), warnings: [] } });

    const upscaleId = await generated({ model: UPSCALE, refs: { video: [sourceId] } });
    expect(recorded.map((entry) => `${entry.method} ${entry.path}`)).toEqual(["POST /api/v0/generate"]);
    expect(JSON.parse(recorded[0]!.body)).toEqual({
      model: "MiniMax-H3",
      task_type: "UPSCALE",
      prompt: "",
      video_config: { height: 1440, duration_secs: 10 },
      src_task_ids: [TASK_ID],
    });
    const pending = engine.jobs.pending.read(upscaleId);
    expect(pending.ok && pending.value).toMatchObject({
      taskId: UPSCALE_TASK_ID,
      taskType: "machgen_media",
      meta: { model: UPSCALE, machgenModel: "MiniMax-H3", sourceVideoIds: [sourceId] },
    });
    const hints = await engine.metadata.artifacts.read(upscaleId, "generation-cost-hints");
    expect(hints.ok && hints.value).toEqual({ durationSeconds: 10, inputDurationSeconds: 10 });
    expect(engine.usage.recent(10).find((entry) => entry.artifactId === upscaleId)).toMatchObject({
      provider: "machgen", model: "MiniMax-H3", status: "pending", externalId: UPSCALE_TASK_ID, costUsd: expect.closeTo(1, 6), warnings: [],
    });
  });

  it("previews the upscale payload a notebook cell would send", async () => {
    const sourceId = await seededVideo(h3Payload(768, 12));
    const sourced = await sourcedGenerationInput(engine, { model: UPSCALE, refs: { video: [sourceId] } });
    expect(sourced.ok).toBe(true);
    if (!sourced.ok) return;
    const preview = previewGeneration(sourced.input);
    expect(preview.ok && preview.preview.payload).toEqual({
      model: "MiniMax-H3", task_type: "UPSCALE", prompt: "", video_config: { height: 1440, duration_secs: 12 }, src_task_ids: ["seeded-task"],
    });
    const other = { model: "machgen:MiniMax-H3", prompt: "x", refs: { first_frame: [sourceId] } };
    expect(await sourcedGenerationInput(engine, other)).toEqual({ ok: true, input: other });
  });

  it.each([
    ["a video MachGen did not generate", null, /was not generated by MachGen/],
    ["a MachGen Seedance 2.5 video", { model: "Seedance-2.5", task_type: "T2V", prompt: "x", video_config: { height: 720, duration_secs: 10 } }, /is a MachGen Seedance-2\.5 video/],
    ["a 1440p MiniMax H3 video", h3Payload(1440, 10), /is 1440p/],
    ["a 4 s MiniMax H3 video", h3Payload(768, 4), /is 4 s/],
    ["a 20 s MiniMax H3 video", h3Payload(768, 20), /is 20 s/],
  ])("refuses to re-render %s before any MachGen call", async (_name, payload, error) => {
    const assetId = await seededVideo(payload);
    const bookId = engine.book.get().bookId;
    const before = engine.artifacts.list().length;
    const result = await client.callTool({ name: "generate_video", arguments: { book_id: bookId, model: UPSCALE, refs: { video: [assetId] } } });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toMatch(error);
    expect(toolText(result)).toContain("MachGen re-renders only its own MiniMax-H3 768p videos of 5-15 s");
    const estimate = await client.callTool({
      name: "estimate_cost",
      arguments: { calls: [{ tool_name: "generate_video", input: { book_id: bookId, model: UPSCALE, refs: { video: [assetId] } } }] },
    });
    expect(JSON.parse(toolText(estimate))).toMatchObject({ estimate: { usd: 0, warnings: [expect.stringMatching(error)] } });
    expect(engine.artifacts.list()).toHaveLength(before);
    expect(recorded).toEqual([]);
  });

  it("refuses to re-render a URL or a video that is still generating", async () => {
    const bookId = engine.book.get().bookId;
    const url = await client.callTool({ name: "generate_video", arguments: { book_id: bookId, model: UPSCALE, refs: { video: [CLIP] } } });
    expect(url.isError).toBe(true);
    expect(toolText(url)).toContain("needs a video from this book, not a URL");
    const sourceId = await submitted();
    await pauseBookQueueForTests(bookId);
    recorded = [];
    const busy = await client.callTool({ name: "generate_video", arguments: { book_id: bookId, model: UPSCALE, refs: { video: [sourceId] } } });
    expect(busy.isError).toBe(true);
    expect(toolText(busy)).toMatch(/is still generating|No video file found/);
    expect(recorded).toEqual([]);
  });
});
