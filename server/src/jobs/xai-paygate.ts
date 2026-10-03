import { createXai } from "../usage-providers.js";

import type { XaiProvider } from "@apicity/xai";
import { mintOtp } from "@apicity/cost";
import type { PayGateApproval } from "@apicity/cost";
import { ensurePaygateSecret } from "./kie-paygate.js";
import { assertProviderPayload } from "../provider-prompt-transform.js";

export const XAI_IMAGE_GENERATIONS_DOT_PATH = "v1.images.generations";
export const XAI_IMAGE_EDITS_DOT_PATH = "v1.images.edits";
export const XAI_VIDEO_GENERATIONS_DOT_PATH = "v1.videos.generations";

type XaiPaidDotPath =
  | typeof XAI_IMAGE_GENERATIONS_DOT_PATH
  | typeof XAI_IMAGE_EDITS_DOT_PATH
  | typeof XAI_VIDEO_GENERATIONS_DOT_PATH;

type XaiPaidMethod<TReq, TRes> = (request: TReq, approval?: PayGateApproval) => Promise<TRes>;

export function createXaiPaygatedProvider(apiKey: string, timeout: number): XaiProvider {
  return createXai({
    apiKey,
    timeout,
    paygate: { secret: ensurePaygateSecret() },
  });
}

export function mintXaiOtp(dotPath: XaiPaidDotPath, request: object, ttlSeconds = 10 * 60): string {
  return mintOtp(ensurePaygateSecret(), {
    provider: "xai",
    method: "POST",
    dotPath,
    request: request as Record<string, unknown>,
    ttl: ttlSeconds,
  });
}

export async function callXaiPaid<TReq extends object, TRes>(
  method: XaiPaidMethod<TReq, TRes>,
  dotPath: XaiPaidDotPath,
  request: TReq,
): Promise<TRes> {
  assertProviderPayload(request, { toolName: dotPath, wire: true });
  return method(request, { otp: mintXaiOtp(dotPath, request) });
}
