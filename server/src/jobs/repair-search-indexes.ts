import type { Engine } from "videobook-engine";
import { buildAssetList } from "../tools/reconcile-project-work.js";
import { missingVisualIndexes } from "../search-index-coverage.js";
import { registerLocalClipSearchProvider } from "../local-search-models.js";
import { registerJobHandler, type JobHandlerContext } from "../queue.js";
import { runSemanticIndex } from "./semantic-index.js";

interface SearchIndexRepairResult {
  indexed: number;
  failed: number;
  failures: Array<{ artifactId: string; message: string }>;
}

export function registerRepairSearchIndexesJob(engine: Engine): void {
  registerJobHandler("repair_search_indexes", (payload, context) =>
    repairSearchIndexes(engine, Array.isArray(payload.kinds) ? payload.kinds : ["image", "video"], context));
}

export function repairSearchIndexes(engine: Engine, requestedKinds: unknown[], context: JobHandlerContext): Promise<SearchIndexRepairResult> {
  return engine.withLocalMedia(async () => {
    context.signal.throwIfAborted();
    const kinds = new Set(requestedKinds);
    const assets = (await buildAssetList(engine, engine.book.get().bookId, "newest"))
      .filter((asset) => kinds.has(asset.type === "final" ? "video" : asset.type));
    const missing = missingVisualIndexes(engine, assets);
    const result: SearchIndexRepairResult = { indexed: 0, failed: 0, failures: [] };
    if (missing.length === 0) return result;
    await registerLocalClipSearchProvider(engine).prepare({ signal: context.signal });
    for (const asset of missing) {
      context.signal.throwIfAborted();
      try {
        const indexed = await runSemanticIndex(engine, {
          type: "semantic_index", assetId: asset.artifact_id, bookId: engine.book.get().bookId, prepareVisualMedia: true, visualOnly: true,
        }, context);
        if (indexed.semanticVisual !== "ready" || missingVisualIndexes(engine, [asset]).length > 0) {
          throw new Error("Visual indexing is incomplete. Check the source media and prepare the local search models before retrying.");
        }
        result.indexed += 1;
      } catch (error) {
        context.signal.throwIfAborted();
        result.failed += 1;
        if (result.failures.length < 10) result.failures.push({
          artifactId: asset.artifact_id, message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  });
}

