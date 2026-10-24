import { scrubHar, type ApicityCallMetadata, type Har, type HarPage } from "@apicity/har";
import type { Engine } from "videobook-engine";
import { captureFileExists, captureFilePath, readCaptureFile, readHarIndex, type HarIndexRow, type HarOutcome } from "./har-index.js";
import { harDirectory, type HarSettings } from "./har-settings.js";
import { readProviderTaskRecord } from "./provider-task-record.js";

export interface HarCaptureKeys {
  bookId: string | null;
  ids: ReadonlySet<string>;
  taskIds: ReadonlySet<string>;
}

export interface GenerationHarStatus {
  mode: HarSettings["mode"];
  hasCapture: boolean;
  captures: number;
  path: string | null;
  outcome: HarOutcome | null;
}

export interface GenerationHarCapture {
  path: string;
  ts: string;
  callId: string;
  provider: string;
  endpoint: string;
  outcome: HarOutcome;
  status: number | null;
}

type CapturePage = HarPage & { _apicity?: ApicityCallMetadata };

function bookIdOf(engine: Engine): string | null {
  try {
    return engine.book.get().bookId;
  } catch {
    return null;
  }
}

export async function captureKeys(engine: Engine, ids: Iterable<string | null | undefined>): Promise<HarCaptureKeys> {
  const known = new Set([...ids].filter((id): id is string => typeof id === "string" && id.length > 0));
  const taskIds = new Set<string>();
  for (const id of known) {
    const task = await readProviderTaskRecord(engine, id).catch(() => null);
    if (task && task.taskId !== "queued") taskIds.add(task.taskId);
  }
  return { bookId: bookIdOf(engine), ids: known, taskIds };
}

export async function generationCaptureKeys(engine: Engine, generationId: string): Promise<HarCaptureKeys> {
  let generation: ReturnType<Engine["generations"]["read"]> | null = null;
  try {
    generation = engine.generations.read(generationId);
  } catch {
    generation = null;
  }
  const row = generation?.ok ? generation.value : null;
  return captureKeys(engine, [generationId, row?.providerArtifactId, row?.outputArtifactId]);
}

function matchesCapture(row: HarIndexRow, keys: HarCaptureKeys): boolean {
  const context = row.context ?? {};
  if (keys.bookId && typeof context.bookId === "string" && context.bookId !== keys.bookId) return false;
  return [context.artifactId, context.attemptId].some((id) => typeof id === "string" && keys.ids.has(id))
    || (typeof context.providerTaskId === "string" && keys.taskIds.has(context.providerTaskId));
}

function chronological(a: HarIndexRow, b: HarIndexRow): number {
  return a.ts.localeCompare(b.ts) || a.callId.localeCompare(b.callId);
}

async function attemptCaptureRows(
  keys: HarCaptureKeys,
  rows?: readonly HarIndexRow[],
  dir: string = harDirectory(),
): Promise<HarIndexRow[]> {
  const matched = (rows ?? await readHarIndex(dir)).filter((row) => matchesCapture(row, keys)).sort(chronological);
  const present = await Promise.all(matched.map((row) => captureFileExists(dir, row.file)));
  return matched.filter((_row, index) => present[index]);
}

export async function generationHarStatus(
  keys: HarCaptureKeys,
  mode: HarSettings["mode"],
  rows?: readonly HarIndexRow[],
  dir: string = harDirectory(),
): Promise<GenerationHarStatus> {
  const captures = await attemptCaptureRows(keys, rows, dir);
  const primary = [...captures].reverse().find((row) => row.outcome !== "ok") ?? captures.at(-1);
  return {
    mode,
    hasCapture: captures.length > 0,
    captures: captures.length,
    path: primary ? captureFilePath(dir, primary.file) : null,
    outcome: primary?.outcome ?? null,
  };
}

function combineCaptures(captures: ReadonlyArray<{ row: HarIndexRow; har: Har }>, generationId: string): Har | null {
  const [first] = captures;
  if (!first || captures.length === 1) return first?.har ?? null;
  const pages: CapturePage[] = captures.map(({ row, har }) => ({
    startedDateTime: har.log._apicity?.startedAt ?? row.ts,
    id: har.log._apicity?.callId ?? row.callId,
    title: `${row.provider} ${row.endpoint} (${row.outcome})`,
    pageTimings: {},
    ...(har.log._apicity ? { _apicity: har.log._apicity } : {}),
  }));
  return {
    log: {
      version: "1.2",
      creator: first.har.log.creator,
      comment: `videobook generation ${generationId}: ${captures.length} captured apicity calls, one page each`,
      pages,
      entries: captures.flatMap(({ row, har }) => har.log.entries.map((entry) => ({
        ...entry,
        pageref: har.log._apicity?.callId ?? row.callId,
      }))),
    },
  };
}

export async function generationHar(
  keys: HarCaptureKeys,
  generationId: string,
  dir: string = harDirectory(),
): Promise<{ captures: GenerationHarCapture[]; har: Har } | null> {
  const loaded: Array<{ row: HarIndexRow; path: string; har: Har }> = [];
  for (const row of await attemptCaptureRows(keys, undefined, dir)) {
    const capture = await readCaptureFile(dir, row.file);
    if (capture) loaded.push({ row, path: capture.path, har: scrubHar(capture.har) });
  }
  const har = combineCaptures(loaded, generationId);
  if (!har) return null;
  return {
    captures: loaded.map(({ row, path }) => ({
      path,
      ts: row.ts,
      callId: row.callId,
      provider: row.provider,
      endpoint: row.endpoint,
      outcome: row.outcome,
      status: row.status ?? null,
    })),
    har,
  };
}
