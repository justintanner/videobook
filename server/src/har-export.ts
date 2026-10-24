import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { scrubHar, type Har } from "@apicity/har";
import { captureFilePath, readCaptureFile, readHarIndex, type HarIndexRow, type HarOutcome } from "./har-index.js";
import { installedPackageVersion } from "./package-version.js";

export interface HarSelection {
  since?: number | null;
  failures?: boolean;
  providers?: readonly string[] | null;
}

export interface HarExportOptions extends HarSelection {
  dir: string;
  out: string;
  now?: Date;
}

type OutcomeCounts = Record<HarOutcome, number>;

export interface HarExportManifest {
  format: "videobook-har-export";
  version: 1;
  createdAt: string;
  videobook: string;
  apicity: { har: string; captured: string[] };
  filters: { since: string | null; failures: boolean; providers: string[] | null };
  files: number;
  dateRange: { first: string | null; last: string | null };
  outcomes: OutcomeCounts;
  providers: Array<{ provider: string; calls: number; outcomes: OutcomeCounts }>;
  endpoints: Array<{ provider: string; endpoint: string; calls: number; outcomes: OutcomeCounts }>;
}

export type HarExportResult =
  | { status: "exported"; out: string; archive: boolean; manifest: HarExportManifest; skipped: string[] }
  | { status: "empty"; skipped: string[] }
  | { status: "needs-scrub"; files: string[] }
  | { status: "out-exists"; out: string }
  | { status: "out-inside-captures"; out: string };

interface VerifiedCapture {
  path: string;
  file: string;
  sha256: string;
  meta: { ts: string; callId: string; provider: string; endpoint: string; outcome: HarOutcome; status: number | null; context: Record<string, unknown> | null };
  apicityVersion: string;
}

const BLOCK = 512;
const OWN_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

function isHarArchivePath(path: string): boolean {
  return /\.(?:tar\.gz|tgz)$/iu.test(path);
}

export function selectHarRows(rows: readonly HarIndexRow[], selection: HarSelection): HarIndexRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.file)) return false;
    seen.add(row.file);
    return (selection.since == null || Date.parse(row.ts) >= selection.since)
      && (!selection.failures || row.outcome !== "ok")
      && (!selection.providers?.length || selection.providers.includes(row.provider));
  });
}

function emptyOutcomes(): OutcomeCounts {
  return { ok: 0, provider_error: 0, local_error: 0, network_error: 0 };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifiedMeta(row: HarIndexRow, har: Har): VerifiedCapture["meta"] {
  const meta = har.log._apicity;
  return {
    ts: meta?.startedAt ?? row.ts,
    callId: meta?.callId ?? row.callId,
    provider: meta?.provider ?? row.provider,
    endpoint: meta?.endpoint ?? row.endpoint,
    outcome: meta?.outcome ?? row.outcome,
    status: meta?.status ?? row.status ?? null,
    context: meta?.context ?? row.context ?? null,
  };
}

function manifestFor(captures: readonly VerifiedCapture[], options: HarExportOptions): HarExportManifest {
  const outcomes = emptyOutcomes();
  const providers = new Map<string, { provider: string; calls: number; outcomes: OutcomeCounts }>();
  const endpoints = new Map<string, { provider: string; endpoint: string; calls: number; outcomes: OutcomeCounts }>();
  for (const { meta } of captures) {
    outcomes[meta.outcome] += 1;
    const provider = providers.get(meta.provider) ?? { provider: meta.provider, calls: 0, outcomes: emptyOutcomes() };
    provider.calls += 1;
    provider.outcomes[meta.outcome] += 1;
    providers.set(meta.provider, provider);
    const key = JSON.stringify([meta.provider, meta.endpoint]);
    const endpoint = endpoints.get(key) ?? { provider: meta.provider, endpoint: meta.endpoint, calls: 0, outcomes: emptyOutcomes() };
    endpoint.calls += 1;
    endpoint.outcomes[meta.outcome] += 1;
    endpoints.set(key, endpoint);
  }
  const times = captures.map(({ meta }) => meta.ts).sort();
  return {
    format: "videobook-har-export",
    version: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    videobook: OWN_VERSION,
    apicity: {
      har: installedPackageVersion("@apicity/har"),
      captured: [...new Set(captures.map((capture) => capture.apicityVersion))].sort(),
    },
    filters: {
      since: options.since == null ? null : new Date(options.since).toISOString(),
      failures: Boolean(options.failures),
      providers: options.providers?.length ? [...options.providers] : null,
    },
    files: captures.length,
    dateRange: { first: times[0] ?? null, last: times.at(-1) ?? null },
    outcomes,
    providers: [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    endpoints: [...endpoints.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.endpoint.localeCompare(b.endpoint)),
  };
}

function indexLines(captures: readonly VerifiedCapture[]): string {
  return captures.map(({ file, meta }) => `${JSON.stringify({
    ts: meta.ts,
    callId: meta.callId,
    provider: meta.provider,
    endpoint: meta.endpoint,
    outcome: meta.outcome,
    ...(meta.status === null ? {} : { status: meta.status }),
    file,
    ...(meta.context ? { context: meta.context } : {}),
  })}\n`).join("");
}

async function* exportEntries(
  captures: readonly VerifiedCapture[],
  manifest: HarExportManifest,
): AsyncGenerator<{ path: string; bytes: Buffer }> {
  yield { path: "manifest.json", bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) };
  yield { path: "index.jsonl", bytes: Buffer.from(indexLines(captures)) };
  for (const capture of captures) {
    const bytes = await readFile(capture.path);
    if (sha256(bytes) !== capture.sha256) throw new Error(`${capture.path} changed during the export; run it again`);
    yield { path: capture.file, bytes };
  }
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function tarHeader(name: string, size: number, type: "0" | "x", mtime: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "utf8");
  header.write(octal(0o600, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(size, 12), 124, "ascii");
  header.write(octal(Math.floor(mtime / 1000), 12), 136, "ascii");
  header.write(" ".repeat(8), 148, "ascii");
  header.write(type, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function paxPath(path: string): Buffer {
  const body = ` path=${path}\n`;
  const bytes = Buffer.byteLength(body);
  let length = bytes + String(bytes).length;
  while (length !== bytes + String(length).length) length = bytes + String(length).length;
  return Buffer.from(`${length}${body}`);
}

function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

async function* tarBlocks(
  entries: AsyncIterable<{ path: string; bytes: Buffer }>,
  root: string,
  mtime: number,
): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    const name = `${root}/${entry.path}`;
    if (Buffer.byteLength(name) > 100) {
      const pax = paxPath(name);
      yield tarHeader("PaxHeader", pax.length, "x", mtime);
      yield pax;
      yield padding(pax.length);
    }
    yield tarHeader(name, entry.bytes.length, "0", mtime);
    yield entry.bytes;
    yield padding(entry.bytes.length);
  }
  yield Buffer.alloc(BLOCK * 2);
}

async function writeArchive(out: string, entries: AsyncIterable<{ path: string; bytes: Buffer }>, mtime: number): Promise<void> {
  const root = basename(out).replace(/\.(?:tar\.gz|tgz)$/iu, "") || "videobook-har";
  const partial = join(dirname(out), `.${basename(out)}.${randomUUID()}.partial`);
  try {
    await pipeline(Readable.from(tarBlocks(entries, root, mtime)), createGzip(), createWriteStream(partial, { flags: "wx", mode: 0o600 }));
    await rename(partial, out);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function writeDirectory(out: string, entries: AsyncIterable<{ path: string; bytes: Buffer }>): Promise<void> {
  const partial = join(dirname(out), `.${basename(out)}.${randomUUID()}.partial`);
  try {
    await mkdir(partial, { mode: 0o700 });
    for await (const entry of entries) {
      const target = join(partial, ...entry.path.split("/"));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, entry.bytes, { flag: "wx", mode: 0o600 });
    }
    await rmdir(out).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(partial, out);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

async function outputTaken(out: string, archive: boolean): Promise<boolean> {
  try {
    const info = await stat(out);
    return archive || !info.isDirectory() || (await readdir(out)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function inside(parent: string, child: string): boolean {
  const location = relative(resolve(parent), resolve(child));
  return location === "" || (location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location));
}

export async function exportHarCaptures(options: HarExportOptions): Promise<HarExportResult> {
  const archive = isHarArchivePath(options.out);
  if (inside(options.dir, options.out)) return { status: "out-inside-captures", out: options.out };
  if (await outputTaken(options.out, archive)) return { status: "out-exists", out: options.out };
  const verified: VerifiedCapture[] = [];
  const skipped: string[] = [];
  const needsScrub: string[] = [];
  for (const row of selectHarRows(await readHarIndex(options.dir), options)) {
    const capture = await readCaptureFile(options.dir, row.file);
    if (!capture) {
      skipped.push(captureFilePath(options.dir, row.file) ?? row.file);
      continue;
    }
    const before = JSON.stringify(capture.har);
    if (JSON.stringify(scrubHar(structuredClone(capture.har))) !== before) {
      needsScrub.push(capture.path);
      continue;
    }
    verified.push({
      path: capture.path,
      file: row.file.split(/[\\/]/u).join("/"),
      sha256: sha256(capture.bytes),
      meta: verifiedMeta(row, capture.har),
      apicityVersion: capture.har.log.creator?.version ?? "unknown",
    });
  }
  if (needsScrub.length > 0) return { status: "needs-scrub", files: needsScrub };
  if (verified.length === 0) return { status: "empty", skipped };
  const manifest = manifestFor(verified, options);
  const entries = exportEntries(verified, manifest);
  await mkdir(dirname(options.out), { recursive: true });
  if (archive) await writeArchive(options.out, entries, (options.now ?? new Date()).getTime());
  else await writeDirectory(options.out, entries);
  return { status: "exported", out: options.out, archive, manifest, skipped };
}
