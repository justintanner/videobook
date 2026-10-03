import { createKie } from "../usage-providers.js";
import { setTimeout as delay } from "node:timers/promises";

import type { KieProvider } from "@apicity/kie";
import { requireApiKey } from "../api-key.js";
import { subjectAnalysisProviderFailureMessage } from "../image-subject-map.js";
import { ensurePaygateSecret } from "./kie-paygate.js";

export const KIE_RESULT_TIMEOUT_MS = 25 * 60_000;

export function kieProvider(): KieProvider {
  return createKie({
    apiKey: requireApiKey("KIE_API_KEY"),
    timeout: 60_000,
    paygate: { secret: ensurePaygateSecret() },
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "Operation aborted",
  );
  error.name = "AbortError";
  return error;
}

function waitForOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadlineAt: number,
  timeoutError: Error,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(timeoutError);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause);
    };
    const onAbort = () => rejectOnce(abortReason(signal));
    const timer = setTimeout(() => rejectOnce(timeoutError), remaining);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation.then(resolveOnce, rejectOnce);
  });
}

export type KieResultContext = "subject-analysis" | "subject-edit";

function kieResultFailureMessage(
  context: KieResultContext,
  message: string | null,
  code: string | null,
): string {
  if (context === "subject-analysis") {
    return subjectAnalysisProviderFailureMessage(message, code);
  }
  const detail = message || code || "Unknown provider error";
  const codeDetail = code && code !== detail ? ` (${code})` : "";
  return `Image subject edit provider failed: ${detail}${codeDetail}`;
}

export async function waitForKieResult(
  provider: KieProvider,
  taskId: string,
  signal: AbortSignal,
  deadlineAt: number,
  context: KieResultContext,
): Promise<string> {
  const timeoutError = context === "subject-analysis"
    ? new Error("Subject analysis did not finish within 25 minutes. Retry the analysis.")
    : new Error(`Kie task ${taskId} did not finish within 25 minutes`);
  while (Date.now() < deadlineAt) {
    const result = await waitForOperation(
      provider.get.api.v1.jobs.recordInfo(taskId),
      signal,
      deadlineAt,
      timeoutError,
    );
    const state = result.data?.state?.toLowerCase();
    if (state === "success") {
      if (!result.data?.resultJson) {
        throw new Error("Kie task succeeded without result JSON");
      }
      return result.data.resultJson;
    }
    if (state === "fail" || state === "failed") {
      throw new Error(kieResultFailureMessage(
        context,
        stringValue(result.data?.failMsg),
        stringValue(result.data?.failCode),
      ));
    }
    await delay(Math.min(3_000, Math.max(1, deadlineAt - Date.now())), undefined, {
      signal,
    });
  }
  throw timeoutError;
}

export function parseResultUrls(resultJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    throw new Error("Seedream returned invalid result JSON");
  }
  const root = record(parsed);
  if (!root) throw new Error("Seedream returned an invalid image result");
  for (const value of [
    root.resultUrls,
    root.result_urls,
    record(root.resultObject)?.resultUrls,
    record(root.resultObject)?.result_urls,
    record(root.result)?.resultUrls,
    record(root.result)?.result_urls,
  ]) {
    if (!Array.isArray(value)) continue;
    const urls = value.flatMap((entry) => stringValue(entry) ?? []);
    if (urls.length > 0) return urls;
  }
  throw new Error("Seedream image edit returned no downloadable images");
}
