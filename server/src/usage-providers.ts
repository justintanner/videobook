import { createFreeMediaUpload as freemediaupload } from "@apicity/free-media-upload";
import { createKimiCoding as kimicoding } from "@apicity/kimicoding";
import { createXOAuth as xoauth } from "@apicity/x";
import { createX as x } from "@apicity/x";
import { createDropbox as dropbox } from "@apicity/dropbox";
import { createB2 as b2 } from "@apicity/b2";
import { createOpenAi as openai } from "@apicity/openai";
import { createXai as xai } from "@apicity/xai";
import { createKie as kie, uploadFile as kieUpload, submitMediaJob as submitKieMediaJob } from "@apicity/kie";
import { createFal as fal, uploadFile as falUpload } from "@apicity/fal";
import { createAlibaba as alibaba, uploadFile as alibabaUpload } from "@apicity/alibaba";
import { createElevenLabs as elevenlabs } from "@apicity/elevenlabs";
import { createMachGen as machgen } from "@apicity/machgen";
import { capturedProvider, withHarCapture, withProviderCall } from "./har-capture.js";
import { providerUsageFetch } from "./provider-usage.js";

export function createOpenAi(options: Parameters<typeof openai>[0]): ReturnType<typeof openai> {
  return capturedProvider("openai", (fetch) => openai({ ...options, fetch }), providerUsageFetch("openai", options.fetch));
}

export function createXai(options: Parameters<typeof xai>[0]): ReturnType<typeof xai> {
  return capturedProvider("xai", (fetch) => xai({ ...options, fetch }), providerUsageFetch("xai", options.fetch));
}

export function createKie(options: Parameters<typeof kie>[0]): ReturnType<typeof kie> {
  return capturedProvider("kie", (fetch) => kie({ ...options, fetch }), providerUsageFetch("kie", options.fetch));
}

export function createFal(options: Parameters<typeof fal>[0]): ReturnType<typeof fal> {
  return capturedProvider("fal", (fetch) => fal({ ...options, fetch }), providerUsageFetch("fal", options.fetch));
}

export function createAlibaba(options: Parameters<typeof alibaba>[0]): ReturnType<typeof alibaba> {
  return capturedProvider("alibaba", (fetch) => alibaba({ ...options, fetch }), providerUsageFetch("alibaba", options.fetch));
}

export function createElevenLabs(options: Parameters<typeof elevenlabs>[0]): ReturnType<typeof elevenlabs> {
  return capturedProvider("elevenlabs", (fetch) => elevenlabs({ ...options, fetch }), providerUsageFetch("elevenlabs", options.fetch));
}

export function createMachGen(options: NonNullable<Parameters<typeof machgen>[0]>): ReturnType<typeof machgen> {
  return capturedProvider("machgen", (fetch) => machgen({ ...options, fetch }), providerUsageFetch("machgen", options.fetch));
}

export function createB2(options: Parameters<typeof b2>[0]): ReturnType<typeof b2> {
  return capturedProvider("b2", (fetch) => b2({ ...options, fetch }), options?.fetch);
}

export function createDropbox(options: Parameters<typeof dropbox>[0]): ReturnType<typeof dropbox> {
  return capturedProvider("dropbox", (fetch) => dropbox({ ...options, fetch }), options?.fetch);
}

export function createX(options: Parameters<typeof x>[0]): ReturnType<typeof x> {
  return capturedProvider("x", (fetch) => x({ ...options, fetch }), options?.fetch);
}

export function createXOAuth(options: Parameters<typeof xoauth>[0]): ReturnType<typeof xoauth> {
  return capturedProvider("x", (fetch) => xoauth({ ...options, fetch }), options?.fetch);
}

export function createKimiCoding(options: Parameters<typeof kimicoding>[0]): ReturnType<typeof kimicoding> {
  return capturedProvider("kimicoding", (fetch) => kimicoding({ ...options, fetch }), options?.fetch);
}

export function createFreeMediaUpload(options: Parameters<typeof freemediaupload>[0] = {}): ReturnType<typeof freemediaupload> {
  return capturedProvider("free-media-upload", (fetch) => freemediaupload({ ...options, fetch }), options?.fetch);
}

export function uploadFalFile(options: Parameters<typeof fal>[0], input: Parameters<typeof falUpload>[1]): Promise<string> {
  return withHarCapture({ provider: "fal", endpoint: "uploadFile", input },
    (fetch) => falUpload(fal({ ...options, fetch }), input), providerUsageFetch("fal", options.fetch));
}

export function uploadAlibabaFile(options: Parameters<typeof alibaba>[0], input: Parameters<typeof alibabaUpload>[1]): Promise<string> {
  return withHarCapture({ provider: "alibaba", endpoint: "uploadFile", input },
    (fetch) => alibabaUpload(alibaba({ ...options, fetch }), input), providerUsageFetch("alibaba", options.fetch));
}

export function uploadKieFile(options: Parameters<typeof kie>[0], file: Blob, filename: string): Promise<string> {
  return withHarCapture({ provider: "kie", endpoint: "uploadFile", input: { file, filename } },
    (fetch) => kieUpload(kie({ ...options, fetch }), file, filename), providerUsageFetch("kie", options.fetch));
}

export function submitMediaJob(...args: Parameters<typeof submitKieMediaJob>): ReturnType<typeof submitKieMediaJob> {
  const [provider, request, approval] = args;
  return withProviderCall(provider, { provider: "kie", endpoint: "api.v1.jobs.createTask", input: request },
    (original) => submitKieMediaJob(original, request, approval));
}
