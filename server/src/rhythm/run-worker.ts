import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RhythmAnalysis } from "./contract.js";

export async function runRhythmWorker(ffmpegPath: string, inputPath: string, signal: AbortSignal, streamIndex?: number): Promise<RhythmAnalysis> {
  signal.throwIfAborted();
  const development = import.meta.url.endsWith(".ts");
  const child = fork(fileURLToPath(new URL(development ? "./worker.ts" : "./worker.js", import.meta.url)), [], {
    execArgv: development ? ["--import", "tsx"] : [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, result?: RhythmAnalysis) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const abort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      killTimer.unref();
      finish(new Error("Music analysis cancelled"));
    };
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (killTimer) clearTimeout(killTimer);
      finish(new Error(`Music analysis stopped (${code}): ${stderr}`));
    });
    child.on("message", (message: { analysis?: RhythmAnalysis; error?: string }) => {
      if (signal.aborted) return;
      if (message.analysis) finish(undefined, message.analysis);
      else finish(new Error(message.error ?? "Music analyzer returned no result"));
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else child.send({ ffmpegPath, inputPath, streamIndex });
  });
}
