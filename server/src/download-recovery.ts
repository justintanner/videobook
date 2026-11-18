import type { Engine } from "videobook-engine";
import { ytdlpChromeProfile } from "./ytdlp-binary.js";

export const DOWNLOAD_FAILURE_METADATA_KEY = "download-failure";

export interface FailedDownload {
  jobId: number;
  message: string;
  tiktokUrl?: string;
  chromeRetryAvailable?: boolean;
}

export function isTikTokUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return (protocol === "https:" || protocol === "http:") && (hostname === "tiktok.com" || hostname.endsWith(".tiktok.com"));
  } catch {
    return false;
  }
}

export function downloadFailureMessage(url: unknown, reason: string): string {
  if (typeof url === "string" && isTikTokUrl(url) && /^login-required:.*\b(?:log ?in|sign in|for the authentication)\b/iu.test(reason)) {
    return "TikTok sign-in required.\nRetry with an account that can view this post, or choose a saved video file.";
  }
  return reason;
}

export async function clearDownloadFailure(engine: Engine, assetId: string): Promise<void> {
  const recorded = await engine.metadata.artifacts.read(assetId, DOWNLOAD_FAILURE_METADATA_KEY);
  if (recorded.ok) await engine.metadata.artifacts.delete(assetId, DOWNLOAD_FAILURE_METADATA_KEY);
}

export function failedDownloadForArtifact(engine: Engine, artifactId: string): FailedDownload | null {
  const [latest] = engine.jobs.queue.list({ artifactId, limit: 1 });
  if (latest?.type !== "download_video" || (latest.state !== "failed" && latest.state !== "aborted")) return null;
  const url = latest.payload.url;
  return {
    jobId: latest.id,
    message: downloadFailureMessage(url, latest.error?.message ?? "The download stopped before the video was saved."),
    ...(typeof url === "string" && isTikTokUrl(url) ? {
      tiktokUrl: url,
      ...(ytdlpChromeProfile() ? { chromeRetryAvailable: true } : {}),
    } : {}),
  };
}
