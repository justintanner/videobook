import { join } from "node:path";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { expect } from "vitest";
import { getChainRun } from "./chain-executor.js";
import { copyVideoFixture } from "./test-media-fixtures.js";
import { probeVideo } from "./ffmpeg.js";
import { registerMediaProbe } from "./notebook-media-ops.js";
import { pauseBookQueueForTests, resumeBookQueueForTests } from "./queue.js";
import { testBudget } from "./test-budget.js";

async function goalTestImage(engine: Engine, label: string, color: string): Promise<string> {
  const created = await engine.artifacts.create("image", label);
  if (!created.ok) throw new Error(created.error.message);
  const written = await engine.files.write(created.value.artifactId, "original.png", await sharp({ create: { width: 96, height: 128, channels: 3, background: color } }).png().toBuffer());
  if (!written.ok) throw new Error(written.error.message);
  return created.value.artifactId;
}

export async function goalTestCharacters(engine: Engine, notebookId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, color] of ["#cf593b", "#2878b4"].entries()) {
    const artifactId = await goalTestImage(engine, `Character ${index + 1}`, color);
    const cell = engine.notebooks.createCell({ type: "image", label: `Character ${index + 1}`, slot: { row: 0, column: index }, outputArtifactId: artifactId });
    const inserted = await engine.notebooks.insertCell(notebookId, cell);
    if (!inserted.ok) throw new Error(inserted.error.message);
    ids.push(artifactId);
  }
  return ids;
}

function goalProviderJob(engine: Engine, artifactId: string) {
  const job = engine.jobs.queue.list().find(item => item.artifactId === artifactId && item.type.startsWith("generate_"));
  if (!job) {
    const seen = engine.jobs.queue.list().map(item => `${item.type}:${item.state}:${item.artifactId ?? ""}`).join(", ");
    throw new Error(`missing provider job for ${artifactId}; queued=[${seen}]`);
  }
  return job;
}

async function completeGoalProviderJob(engine: Engine, artifactId: string): Promise<void> {
  const job = goalProviderJob(engine, artifactId);
  let current = job;
  if (current.state === "queued") {
    let leased = engine.jobs.queue.dequeue(process.pid, 60_000);
    while (leased?.type === "process_image") {
      await engine.jobs.queue.complete(leased.id, { result: { settled: true } });
      leased = engine.jobs.queue.dequeue(process.pid, 60_000);
    }
    if (!leased || leased.id !== job.id) throw new Error(`leased ${leased?.type ?? "nothing"} instead of ${job.type}`);
    current = leased;
  }
  const completed = await engine.jobs.queue.complete(current.id, { result: { settled: true } });
  if (!completed) throw new Error(`could not complete ${job.type} from ${current.state}`);
}

export async function settleGoalChain(engine: Engine, root: string, chainId: string, kind: "image" | "video"): Promise<string> {
  const bookId = engine.book.get().bookId;
  await expect.poll(() => {
    const step = getChainRun(engine, chainId)?.steps[0];
    const artifactId = step?.outputs?.asset_id;
    return step?.status === "running" && typeof artifactId === "string" && step.childJobIds.length > 0;
  }, { timeout: testBudget(15_000) }).toBe(true);
  const step = getChainRun(engine, chainId)!.steps[0]!;
  const artifactId = String(step.outputs?.asset_id);
  if (kind === "image") {
    const written = await engine.files.write(artifactId, "original.jpg", await sharp({ create: { width: 96, height: 54, channels: 3, background: "#cf593b" } }).jpeg().toBuffer());
    if (!written.ok) throw new Error(written.error.message);
  } else {
    const path = join(root, `${artifactId}.mp4`);
    await copyVideoFixture({ width: 160, height: 90, durationSec: 4, fps: 12, source: "color", color: "blue", audio: { frequency: 440 } }, path);
    const written = await engine.files.writeFromPath(artifactId, "original.mp4", path);
    if (!written.ok) throw new Error(written.error.message);
    await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(path));
  }
  await completeGoalProviderJob(engine, artifactId);
  await expect.poll(() => engine.jobs.queue.list().some(job => job.type === "await_notebook_output" && job.payload.providerArtifactId === artifactId), { timeout: testBudget(15_000) }).toBe(true);
  await resumeBookQueueForTests(bookId);
  await expect.poll(() => getChainRun(engine, chainId)?.status, { timeout: testBudget(20_000) }).toBe("completed");
  await pauseBookQueueForTests(bookId);
  return artifactId;
}
