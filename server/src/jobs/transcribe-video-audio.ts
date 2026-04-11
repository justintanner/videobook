import type { ClipfirstFs } from "clipfirst-fs";
import { join } from "node:path";
import { openai } from "@apicity/openai";
import { registerJobHandler } from "../queue.js";
import { runFfmpeg } from "../ffmpeg.js";

type TranscribeVideoAudioPayload = {
  type: "transcribe_video_audio";
  videoPath: string;
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

export function registerTranscribeVideoAudioJob(fs: ClipfirstFs): void {
  registerJobHandler("transcribe_video_audio", async (payload) => {
    const {
      videoPath, assetId, assetDir, projectSlug,
    } = payload as TranscribeVideoAudioPayload;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { success: false, reason: "OPENAI_API_KEY not set" };

    const mp3Path = join(assetDir, "original.mp3");
    await runFfmpeg(["-y", "-i", videoPath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", mp3Path]);

    const readResult = await fs.readFile(assetId, "original.mp3", projectSlug);
    if (!readResult.ok) throw new Error(readResult.error.message);

    const file = new File([new Uint8Array(readResult.value)], "original.mp3", { type: "audio/mpeg" });
    const provider = openai({ apiKey, timeout: 120_000 });
    const result = await provider.post.v1.audio.transcriptions({
      file,
      model: "gpt-4o-mini-transcribe",
    });

    const jsonString = JSON.stringify(result, null, 2);
    await fs.writeFile(assetId, ".analysis.gpt4otrans.json", jsonString, projectSlug);

    return { success: true, text: result.text };
  });
}
