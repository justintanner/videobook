import { makeCancelSignal, type CancelSignal } from "@remotion/renderer";

export async function withRemotionCancellation<T>(
  signal: AbortSignal,
  render: (cancelSignal: CancelSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const { cancelSignal, cancel } = makeCancelSignal();
  const abort = (): void => cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await render(cancelSignal);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
