import type { ClipfirstFs } from "clipfirst-engine";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadBytesToFreeHost, contentHash } from "../upload.js";
import { registerJobHandler } from "../queue.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
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
  registerJobHandler("isolate_vocals", async (payload, ctx) => {
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

    // Upload to KIE with a content-hash filename to avoid collisions with
    // other assets that share the same local filename (e.g. `original.mp3`).
    const ext = audioFilename.split(".").pop() ?? "bin";
    const hashedName = `${contentHash(uploadBuffer)}.${ext}`;
    const downloadUrl = await uploadBytesToFreeHost(uploadBuffer, hashedName);

    // Create isolation task
    const request = {
      model: "elevenlabs/audio-isolation" as const,
      input: {
        audio_url: downloadUrl,
      },
    };
    const taskId = await submitMediaJob(provider, request);

    // Write pending task
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "isolate_vocals",
        assetId,
        assetDir,
        meta: {
          isAudioAsset,
          ...(originalDuration !== undefined ? { originalDuration } : {}),
        },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${assetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
