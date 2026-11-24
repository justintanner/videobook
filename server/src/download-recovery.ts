import type { Engine } from "videobook-engine";
import { ytdlpChromeProfile } from "./ytdlp-binary.js";

export const DOWNLOAD_FAILURE_METADATA_KEY = "download-failure";

export interface FailedDownload {
  jobId: number;
  message: string;
  tiktokUrl?: string;
  chromeRetryAvailable?: boolean;
  signInRequired?: boolean;
}

export function isTikTokUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return (protocol === "https:" || protocol === "http:") && (hostname === "tiktok.com" || hostname.endsWith(".tiktok.com"));
  } catch {
    return false;
  }
}

export function isTikTokSignInFailure(reason: string): boolean {
  return /^(?:login-required|private):[\s\S]*\b(?:(?:log|sign)[ -]?in(?:to)?|for the authentication)\b/iu.test(reason)
    || /^TikTok (?:sign-in required|requires sign-in for this post)\./u.test(reason);
}

export function downloadFailureMessage(url: unknown, reason: string, signInRequired = isTikTokSignInFailure(reason)): string {
  if (typeof url === "string" && isTikTokUrl(url) && signInRequired) {
    return "TikTok sign-in required.\nRetry with an account that can view this post, or choose a saved video file.";
  }
  return reason;
}

export async function clearDownloadFailure(engine: Engine, assetId: string): Promise<void> {
  const recorded = await engine.metadata.artifacts.read(assetId, DOWNLOAD_FAILURE_METADATA_KEY);
  if (recorded.ok) await engine.metadata.artifacts.delete(assetId, DOWNLOAD_FAILURE_METADATA_KEY);
  const failure = engine.jobs.failures.read(assetId);
  if (!failure.ok || !failure.value) return;
  const cleared = await engine.jobs.failures.clear(assetId);
  if (!cleared.ok) throw new Error(cleared.error.message);
}

export function failedDownloadForArtifact(engine: Engine, artifactId: string): FailedDownload | null {
  const [latest] = engine.jobs.queue.list({ artifactId, limit: 1 });
  if (latest?.type !== "download_video" || (latest.state !== "failed" && latest.state !== "aborted")) return null;
  const url = latest.payload.url;
  const reason = latest.error?.message ?? "The download stopped before the video was saved.";
  const signInRequired = isTikTokSignInFailure(reason);
  return {
    jobId: latest.id,
    message: downloadFailureMessage(url, reason, signInRequired),
    ...(typeof url === "string" && isTikTokUrl(url) ? {
      tiktokUrl: url,
      ...(signInRequired ? { signInRequired: true } : {}),
      ...(ytdlpChromeProfile() ? { chromeRetryAvailable: true } : {}),
    } : {}),
  };
}
