import { renderCleanup, type CleanupRender } from "./render-local.js";

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("disconnect", () => controller.abort());

async function send(message: unknown): Promise<void> {
  if (!process.connected || !process.send) return;
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error: Error | null) => error ? reject(error) : resolve());
  });
}

process.once("message", async (input: Omit<CleanupRender, "signal" | "onProgress">) => {
  let lastProgress = 0;
  try {
    await renderCleanup({ ...input, signal: controller.signal, onProgress: progress => {
      const now = Date.now();
      if (progress.completedFrames !== 0 && progress.completedFrames !== progress.totalFrames && now - lastProgress < 500) return;
      lastProgress = now;
      if (process.connected) process.send?.({ progress });
    } });
    await send({ completed: true });
  } catch (error) {
    await send({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (process.connected) process.disconnect?.();
  }
});
