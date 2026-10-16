import type { AlibabaMultimodalGenerationRequest } from "@apicity/alibaba/zod";
import type { Engine } from "videobook-engine";
import { createAlibaba } from "../../usage-providers.js";
import { requireApiKey } from "../../api-key.js";
import { uploadAssetToAlibaba } from "../../jobs/_alibaba-upload.js";
import type { ProviderAdapter, SubmitContext, SubmitResult } from "./types.js";

async function submit(request: Record<string, unknown>, _context: SubmitContext): Promise<SubmitResult> {
  const provider = createAlibaba({ apiKey: requireApiKey("DASHSCOPE_API_KEY"), timeout: 120_000 });
  const response = await provider.post.api.v1.services.aigc.multimodalGeneration.generation(
    request as unknown as AlibabaMultimodalGenerationRequest,
  );
  const urls = response.output.choices.flatMap((choice) =>
    choice.message.content.flatMap((part) => part.image ? [part.image] : []));
  if (urls.length === 0) throw new Error("Alibaba response contained no image URLs");
  return { kind: "done", taskId: response.request_id, outputs: urls.map((url) => ({ url })) };
}

export function alibabaAdapterFor(apiId: string): ProviderAdapter {
  return {
    provider: "alibaba",
    envKey: "DASHSCOPE_API_KEY",
    upload: (engine: Engine, assetId: string, filename: string) => uploadAssetToAlibaba(engine, assetId, filename, apiId),
    uploadUrl: async (url) => url,
    submit,
  };
}
