import type { Engine } from "videobook-engine";
import { queue, registerJobHandler } from "../queue.js";

export async function enqueueTemporalSearchPreparation(bookId: string) {
  const job = await queue.enqueue(`prepare-temporal-search:${bookId}`, {
    type: "prepare_temporal_search",
    bookId,
  });
  return { bookId, jobId: job.id };
}

export function registerPrepareTemporalSearchJob(engine: Engine): void {
  registerJobHandler("prepare_temporal_search", async (_payload, context) => {
    const result = await engine.temporalSearch.prepare({ signal: context.signal });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  });
}
