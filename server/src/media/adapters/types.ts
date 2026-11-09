import type { Engine } from "videobook-engine";
import type { CostHints } from "@apicity/cost";
import type { JobHandlerContext } from "../../queue.js";
import type { UploadLimits } from "../../upload.js";
import type { ProviderId, ResolvedModel } from "../types.js";

export type ProviderOutput = { url: string } | { bytes: Buffer; extension: string; url?: string };

export interface SubmitContext {
  engine: Engine;
  ctx: JobHandlerContext;
  model: ResolvedModel;
  bookId: string;
  assetId: string;
  assetDir: string;
  meta: Record<string, unknown>;
  costHints: CostHints;
}

export type SubmitResult =
  | { kind: "pending"; taskId: string }
  | { kind: "done"; taskId: string; outputs: ProviderOutput[] };

export interface ProviderAdapter {
  provider: ProviderId;
  envKey: string;
  upload(engine: Engine, assetId: string, filename: string, signal?: AbortSignal, limits?: UploadLimits): Promise<string>;
  uploadUrl(url: string): Promise<string>;
  submit(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult>;
}

export const MEDIA_TASK_TYPES = {
  kie: "media_kie",
  fal: "fal_media",
  xai: "xai_media",
  machgen: "machgen_media",
  wavespeed: "wavespeed_media",
} as const;
