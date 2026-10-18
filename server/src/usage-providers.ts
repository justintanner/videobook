import { createOpenAi as openai } from "@apicity/openai";
import { createXai as xai } from "@apicity/xai";
import { createKie as kie } from "@apicity/kie";
import { createFal as fal } from "@apicity/fal";
import { createAlibaba as alibaba } from "@apicity/alibaba";
import { createElevenLabs as elevenlabs } from "@apicity/elevenlabs";
import { providerUsageFetch } from "./provider-usage.js";

export function createOpenAi(options: Parameters<typeof openai>[0]): ReturnType<typeof openai> {
  return openai({ ...options, fetch: providerUsageFetch("openai", options.fetch) });
}

export function createXai(options: Parameters<typeof xai>[0]): ReturnType<typeof xai> {
  return xai({ ...options, fetch: providerUsageFetch("xai", options.fetch) });
}

export function createKie(options: Parameters<typeof kie>[0]): ReturnType<typeof kie> {
  return kie({ ...options, fetch: providerUsageFetch("kie", options.fetch) });
}

export function createFal(options: Parameters<typeof fal>[0]): ReturnType<typeof fal> {
  return fal({ ...options, fetch: providerUsageFetch("fal", options.fetch) });
}

export function createAlibaba(options: Parameters<typeof alibaba>[0]): ReturnType<typeof alibaba> {
  return alibaba({ ...options, fetch: providerUsageFetch("alibaba", options.fetch) });
}

export function createElevenLabs(options: Parameters<typeof elevenlabs>[0]): ReturnType<typeof elevenlabs> {
  return elevenlabs({ ...options, fetch: providerUsageFetch("elevenlabs", options.fetch) });
}
