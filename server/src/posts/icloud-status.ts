import { execFile } from "node:child_process";

export type ICloudSyncPhase = "uploaded" | "uploading" | "error" | "not-icloud";

export interface ICloudSyncStatus {
  phase: ICloudSyncPhase;
  error: string | null;
}

export interface UbiquitousItemState {
  path: string;
  exists: boolean;
  ubiquitous: boolean | null;
  shared: boolean | null;
  role: "owner" | "participant" | null;
  uploaded: boolean | null;
  uploading: boolean | null;
  error: string | null;
}

const SCRIPT = `ObjC.import("Foundation");
function run(argv) {
  return JSON.stringify(argv.map(function (path) {
    var url = $.NSURL.fileURLWithPath(path);
    function get(key) { var out = Ref(); if (!url.getResourceValueForKeyError(out, key, null)) return null; var v = out[0]; return v === undefined || v === null || (v.isNil && v.isNil()) ? null : ObjC.unwrap(v); }
    var err = get($.NSURLUbiquitousItemUploadingErrorKey);
    return { path: path, exists: $.NSFileManager.defaultManager.fileExistsAtPath(path), ubiquitous: get($.NSURLIsUbiquitousItemKey), shared: get($.NSURLUbiquitousItemIsSharedKey), role: get($.NSURLUbiquitousSharedItemCurrentUserRoleKey), uploaded: get($.NSURLUbiquitousItemIsUploadedKey), uploading: get($.NSURLUbiquitousItemIsUploadingKey), error: err ? ObjC.unwrap(err.localizedDescription) : null };
  }));
}`;

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : typeof value === "number" ? value !== 0 : null;
}

function role(value: unknown): UbiquitousItemState["role"] {
  if (typeof value !== "string") return null;
  if (value.endsWith("Owner")) return "owner";
  if (value.endsWith("Participant")) return "participant";
  return null;
}

export function parseUbiquitousStates(output: string): UbiquitousItemState[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("Unexpected iCloud status output");
  return parsed.map((item: unknown) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const ubiquitous = flag(record.ubiquitous) === true;
    return {
      path: typeof record.path === "string" ? record.path : "",
      exists: record.exists === true,
      ubiquitous: flag(record.ubiquitous),
      shared: ubiquitous ? flag(record.shared) ?? false : null,
      role: ubiquitous ? role(record.role) : null,
      uploaded: ubiquitous ? flag(record.uploaded) : null,
      uploading: ubiquitous ? flag(record.uploading) : null,
      error: typeof record.error === "string" && record.error ? record.error : null,
    };
  });
}

export function summarizeUbiquitousSync(states: readonly UbiquitousItemState[] | null): ICloudSyncStatus {
  if (!states || states.length === 0 || states.some((state) => state.ubiquitous !== true)) return { phase: "not-icloud", error: null };
  const error = states.find((state) => state.error)?.error ?? null;
  if (error) return { phase: "error", error };
  return states.every((state) => state.uploaded === true && state.uploading !== true)
    ? { phase: "uploaded", error: null }
    : { phase: "uploading", error: null };
}

export async function readUbiquitousStates(paths: string[]): Promise<UbiquitousItemState[] | null> {
  if (process.platform !== "darwin" || paths.length === 0) return null;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile("osascript", ["-l", "JavaScript", "-e", SCRIPT, ...paths], { timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    return parseUbiquitousStates(output);
  } catch {
    return null;
  }
}
