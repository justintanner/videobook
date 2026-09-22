import { analyzeAudioFile } from "./analyze.js";

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("disconnect", () => controller.abort());
async function send(message: unknown) {
  if (!process.connected || !process.send) return;
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error: Error | null) => error ? reject(error) : resolve());
  });
}
process.once("message", async (message: { ffmpegPath: string; inputPath: string; streamIndex?: number }) => {
  try {
    const analysis = await analyzeAudioFile(message.ffmpegPath, message.inputPath, controller.signal, message.streamIndex);
    await send({ analysis });
  } catch (error) {
    if (process.connected) await send({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (process.connected) process.disconnect?.();
  }
});
