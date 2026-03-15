import type { ClipfirstFs } from "clipfirst-fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { kie } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import { writePendingTask } from "./pending-task.js";

const MIN_ISOLATION_DURATION = 4.6;
const PAD_TARGET_DURATION = 5.0;

type IsolateVocalsPayload = {
  type: "isolate_vocals";
  audioPath: string;
  audioFilename: string;
  assetId: string;
  assetDir: string;
  projectSlug: string;
  isAudioAsset: boolean;
};

export function registerIsolateVocalsJob(fs: ClipfirstFs): void {
  registerJobHandler("isolate_vocals", async (payload) => {
    const {
      audioFilename, assetId, assetDir, projectSlug, isAudioAsset,
    } = payload as IsolateVocalsPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    // Read audio file from asset
    const readResult = await fs.readFile(assetId, audioFilename, projectSlug);
    if (!readResult.ok) throw new Error(readResult.error.message);
    const audioBuffer = Buffer.from(readResult.value);

    // Check duration and pad if needed
    const probe = await probeVideo(join(assetDir, audioFilename));
    let uploadBuffer = audioBuffer;
    let originalDuration: number | undefined;

    if (probe.duration < MIN_ISOLATION_DURATION) {
      originalDuration = probe.duration;
      const padSeconds = PAD_TARGET_DURATION - probe.duration;
      const tmpInput = join(tmpdir(), `isolate-pad-in-${Date.now()}.mp3`);
      const tmpOutput = join(tmpdir(), `isolate-pad-out-${Date.now()}.mp3`);

      try {
        await writeFile(tmpInput, audioBuffer);
        await runFfmpeg([
          "-y", "-i", tmpInput,
          "-af", `apad=pad_dur=${padSeconds}`,
          tmpOutput,
        ]);
        const { readFile: readFs } = await import("node:fs/promises");
        uploadBuffer = await readFs(tmpOutput);
      } finally {
        await unlink(tmpInput).catch(() => {});
        await unlink(tmpOutput).catch(() => {});
      }
    }

    // Upload to KIE
    const blob = new Blob([new Uint8Array(uploadBuffer)]);
    const { downloadUrl } = await provider.api.fileStreamUpload({
      file: blob,
      filename: audioFilename,
    });

    // Create isolation task
    const { taskId } = await provider.api.v1.jobs.createTask({
      model: "elevenlabs/audio-isolation",
      input: {
        audio_url: downloadUrl,
      },
    });

    // Write pending task
    await writePendingTask(fs, assetId, projectSlug, {
      taskId,
      taskType: "isolate_vocals",
      assetId,
      assetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        isAudioAsset,
        ...(originalDuration !== undefined ? { originalDuration } : {}),
      },
    });

    return { success: true, taskId };
  });
}
