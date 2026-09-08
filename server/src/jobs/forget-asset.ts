import type { Engine } from "videobook-engine";
import { forgetAsset, type ForgetAssetOutcome } from "../forget-asset.js";
import { registerJobHandler } from "../queue.js";

/**
 * `forgetArtifactId`, not `assetId`: the queue attributes a job carrying an
 * asset id to that artifact, and deleting an artifact aborts its own jobs —
 * including this one.
 */
interface ForgetAssetPayload {
  type: "forget_asset";
  bookId: string;
  forgetArtifactId: string;
  clearReferences: boolean;
}

export function registerForgetAssetJob(engine: Engine): void {
  registerJobHandler(
    "forget_asset",
    async (payload): Promise<ForgetAssetOutcome> => {
      const input = payload as unknown as ForgetAssetPayload;
      return await forgetAsset(engine, {
        assetId: input.forgetArtifactId,
        clearReferences: input.clearReferences === true,
      });
    },
  );
}
