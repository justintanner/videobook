import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PostICloudFile } from "./post-contract.js";
import type { ICloudSyncStatus } from "./icloud-status.js";

export const RELAY_UPLOADED_FILE = ".videobook-icloud-uploaded";
export const RELAY_ERROR_FILE = ".videobook-icloud-error";

type RelayFile = Pick<PostICloudFile, "path" | "size">;

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export function parseRelayUploaded(text: string): Map<string, number> {
  const uploaded = new Map<string, number>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf(";");
    if (separator <= 0) continue;
    const size = Number(line.slice(0, separator));
    if (Number.isSafeInteger(size)) uploaded.set(line.slice(separator + 1), size);
  }
  return uploaded;
}

export function summarizeRelaySync(files: readonly RelayFile[], uploaded: ReadonlyMap<string, number>, error: string | null): ICloudSyncStatus {
  if (files.every((file) => uploaded.get(file.path) === file.size)) return { phase: "uploaded", error: null };
  return error ? { phase: "error", error } : { phase: "uploading", error: null };
}

export async function readRelaySync(root: string, files: readonly RelayFile[]): Promise<ICloudSyncStatus | null> {
  const parent = dirname(root);
  const [uploaded, error] = await Promise.all([readOptional(join(parent, RELAY_UPLOADED_FILE)), readOptional(join(parent, RELAY_ERROR_FILE))]);
  if (uploaded === null && error === null) return null;
  return summarizeRelaySync(files, parseRelayUploaded(uploaded ?? ""), error?.trim() || null);
}
