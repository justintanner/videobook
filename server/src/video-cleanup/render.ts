import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CleanupProgress, CleanupRender } from "./render-local.js";

export async function renderCleanup(input: CleanupRender): Promise<void> {
  input.signal.throwIfAborted();
  const development = import.meta.url.endsWith(".ts");
  const child = fork(fileURLToPath(new URL(development ? "./render-worker.ts" : "./render-worker.js", import.meta.url)), [], {
    execArgv: development ? ["--import", "tsx"] : [],
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  await new Promise<void>((resolve, reject) => {
    let completed = false;
    let failure: Error | null = null;
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { child.kill(signal); }
    };
    const abort = () => {
      failure = new Error("Video removal cancelled");
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2000);
      killTimer.unref();
    };
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.on("error", error => { failure = error; });
    child.on("message", (message: { completed?: boolean; error?: string; progress?: CleanupProgress }) => {
      if (input.signal.aborted) return;
      if (message.progress) {
        try { input.onProgress?.(message.progress); } catch (error) {
          abort();
          failure = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (message.error) failure = new Error(message.error);
      completed ||= message.completed === true;
    });
    child.on("close", code => {
      if (killTimer) clearTimeout(killTimer);
      input.signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (completed && code === 0) resolve();
      else reject(new Error(`Video removal stopped (${code}): ${stderr}`));
    });
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    else {
      const { signal: _signal, onProgress: _onProgress, ...request } = input;
      child.send(request, error => { if (error) { failure = error; kill("SIGTERM"); } });
    }
  });
  input.signal.throwIfAborted();
}
