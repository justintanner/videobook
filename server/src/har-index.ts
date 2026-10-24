import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ApicityCallMetadata, Har } from "@apicity/har";
import { harDirectory } from "./har-settings.js";

export type HarOutcome = ApicityCallMetadata["outcome"];

export interface HarIndexRow {
  ts: string;
  callId: string;
  provider: string;
  endpoint: string;
  outcome: HarOutcome;
  status?: number;
  file: string;
  context?: Record<string, unknown>;
}

export interface HarCaptureFile {
  path: string;
  bytes: Buffer;
  har: Har;
}

const OUTCOMES: ReadonlySet<string> = new Set(["ok", "provider_error", "local_error", "network_error"]);

let indexCache: { path: string; key: string; rows: readonly HarIndexRow[] } | null = null;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function indexRow(line: string): HarIndexRow | null {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { return null; }
  const row = record(value);
  if (!row || typeof row.ts !== "string" || typeof row.callId !== "string" || typeof row.provider !== "string"
    || typeof row.endpoint !== "string" || typeof row.outcome !== "string" || !OUTCOMES.has(row.outcome)
    || typeof row.file !== "string") return null;
  const context = record(row.context);
  return {
    ts: row.ts,
    callId: row.callId,
    provider: row.provider,
    endpoint: row.endpoint,
    outcome: row.outcome as HarOutcome,
    ...(typeof row.status === "number" ? { status: row.status } : {}),
    file: row.file,
    ...(context ? { context } : {}),
  };
}

export async function readHarIndex(dir: string = harDirectory()): Promise<readonly HarIndexRow[]> {
  const path = join(dir, "index.jsonl");
  let key: string;
  try {
    const info = await stat(path);
    key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (indexCache?.path === path && indexCache.key === key) return indexCache.rows;
  const text = await readFile(path, "utf8");
  const rows = text.split("\n").flatMap((line) => {
    const row = line.trim() ? indexRow(line) : null;
    return row ? [row] : [];
  });
  indexCache = { path, key, rows };
  return rows;
}

export function captureFilePath(dir: string, file: string): string | null {
  if (!file.endsWith(".har") || isAbsolute(file) || file.includes("\0")) return null;
  const parts = file.split(/[\\/]/u);
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return join(dir, ...parts);
}

function isHar(value: unknown): value is Har {
  const log = record(record(value)?.log);
  return Boolean(log && Array.isArray(log.entries));
}

export async function readCaptureFile(dir: string, file: string): Promise<HarCaptureFile | null> {
  const path = captureFilePath(dir, file);
  if (!path) return null;
  try {
    if (!(await lstat(path)).isFile()) return null;
    const location = relative(await realpath(dir), await realpath(path));
    if (location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)) return null;
    const bytes = await readFile(path);
    const har: unknown = JSON.parse(bytes.toString("utf8"));
    return isHar(har) ? { path, bytes, har } : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function captureFileExists(dir: string, file: string): Promise<boolean> {
  const path = captureFilePath(dir, file);
  if (!path) return false;
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}
