import { createFal, FalError } from "@apicity/fal";
import type { FalEndpointId, FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { requireApiKey } from "../api-key.js";
type FalTaskType = `fal_${string}`;

type FalSubmitArgs<E extends string> = {
  engine: Engine;
  bookId: string;
  assetId: string;
  assetDir: string;
  endpointId: E;
  input: E extends FalEndpointId ? FalEndpointInputMap[E] : Record<string, unknown>;
  taskType: FalTaskType;
  meta: Record<string, unknown>;
  /** Local job lease to hand off to the provider lease atomically. */
  expectedOwnerId: string;
};

export async function submitFalJob<E extends string>(args: FalSubmitArgs<E>): Promise<string> {
  const apiKey = requireApiKey("FAL_API_KEY");

  const provider = createFal({ apiKey, timeout: 60_000 });

  await args.engine.metadata.artifacts.write(args.assetId, "generation-payload", { endpoint_id: args.endpointId, input: args.input }
  );

  let submit;
  try {
    submit = await provider.post.v1.queue.submit({
      endpoint_id: args.endpointId,
      input: args.input,
    });
  } catch (cause) {
    const message = describeFalError(cause);
    if (cause instanceof Error && message === cause.message) throw cause;
    throw new Error(message, { cause });
  }

  const ptResult = await args.engine.jobs.pending.write({
      taskId: submit.request_id,
      taskType: args.taskType,
      artifactId: args.assetId,
      meta: {
        ...args.meta,
        falEndpointId: args.endpointId,
      },
    }, args.expectedOwnerId
  );
  if (!ptResult.ok) {
    throw new Error(`Failed to write pending-task for ${args.assetId}: ${ptResult.error.message}`);
  }
  if (ptResult.value === null) {
    throw new Error(
      `Lost local lease for ${args.assetId} during FAL submission; the asset's owner changed mid-flight`,
    );
  }

  return submit.request_id;
}

export function describeFalError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (!(cause instanceof FalError)) return message;
  if (!cause.body || typeof cause.body !== "object") return message;
  const detail = (cause.body as Record<string, unknown>).detail;
  if (typeof detail !== "string" || detail.length === 0 || message.includes(detail)) return message;
  return `${message}: ${detail}`;
}
