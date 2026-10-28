import { harDirectory, readHarSettings } from "../har-settings.js";
import { execFile } from "node:child_process";
import { access, constants, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { SCHEMA_VERSION } from "videobook-engine/catalog-metadata";
import type { DoctorFlags } from "./args.js";
import { resolvePort } from "./args.js";
import { dataLayout } from "../data-home.js";
import { bookManager } from "../engine.js";
import { MANAGED_ENV_KEYS, getDefaultSecretStore } from "../env-secrets.js";
import { FFMPEG } from "../ffmpeg-binary.js";
import { FFPROBE, bundledFfprobe } from "../ffprobe-binary.js";
import { inspectServerOwner } from "../server-lock.js";
import { readOnePasswordSettings, type OnePasswordResolution } from "../one-password.js";
import { remotionBrowserDir, remotionCacheRoot } from "../remotion/browser.js";
import { resolveYtdlp, ytdlpCookiesSetting, ytdlpImpersonateTargets, type YtdlpCookiesSetting } from "../ytdlp-binary.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  remedy?: string;
  required: boolean;
}

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ALLOW_SCRIPTS = "ffmpeg-static,ytdlp-nodejs,@dolthub/doltlite,usearch,onnxruntime-node,esbuild";
const INSTALL_REMEDY = `Reinstall with install scripts allowed: npm install -g videobook --allow-scripts=${ALLOW_SCRIPTS}`;

function check(fields: DoctorCheck): DoctorCheck {
  return fields;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);
}

function nodeCheck(): DoctorCheck {
  const engines = (require("../../package.json") as { engines?: { node?: string } }).engines?.node ?? ">=22";
  const minimum = Number(/(\d+)/u.exec(engines)?.[1] ?? 22);
  const major = Number(process.versions.node.split(".")[0]);
  return check({
    id: "node",
    label: "Node.js",
    status: major >= minimum ? "ok" : "fail",
    detail: `${process.version} (needs ${engines})`,
    ...(major >= minimum ? {} : { remedy: `Install Node.js ${minimum} or newer.` }),
    required: true,
  });
}

async function nearestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await access(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

async function dataHomeCheck(): Promise<DoctorCheck> {
  const layout = dataLayout();
  const kind = layout.kind === "checkout" ? "source checkout" : process.env.VIDEOBOOK_HOME?.trim() ? "VIDEOBOOK_HOME" : "default";
  const target = await nearestExisting(layout.root);
  try {
    await access(target, constants.W_OK);
    return check({ id: "data-home", label: "Data home", status: "ok", detail: `${layout.root} (${kind}); .env ${layout.envPath}`, required: true });
  } catch {
    return check({
      id: "data-home",
      label: "Data home",
      status: "fail",
      detail: `${layout.root} is not writable (${kind})`,
      remedy: "Set VIDEOBOOK_HOME or pass --home to a writable directory.",
      required: true,
    });
  }
}

async function harCaptureCheck(): Promise<DoctorCheck> {
  const settings = await readHarSettings();
  const dir = harDirectory();
  let writable = true;
  try { await access(await nearestExisting(dir), constants.W_OK); }
  catch { writable = false; }
  return check({ id: "har-capture", label: "HAR capture", status: writable || settings.mode === "off" ? "ok" : "warn",
    detail: `${settings.mode}; ${dir}; writable: ${writable ? "yes" : "no"}`, required: false });
}

async function libraryCheck(): Promise<DoctorCheck> {
  const libraryDir = bookManager.rootDir;
  try {
    const books = (await readdir(libraryDir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && UUID_V7.test(entry.name));
    return check({ id: "library", label: "Library", status: "ok", detail: `${libraryDir}: ${books.length} book(s), schema ${SCHEMA_VERSION}`, required: false });
  } catch {
    return check({ id: "library", label: "Library", status: "ok", detail: `${libraryDir} is created on first start (schema ${SCHEMA_VERSION})`, required: false });
  }
}

function bundledPath(moduleName: string): string | null {
  try {
    const value = require(moduleName) as string | { path?: string } | null;
    return typeof value === "string" ? value : value?.path ?? null;
  } catch {
    return null;
  }
}

async function binaryCheck(id: string, label: string, binary: string, bundled: string | null, envName: string): Promise<DoctorCheck> {
  const origin = binary === bundled ? "bundled" : binary.includes("/") ? envName : "from PATH";
  try {
    const { stdout } = await execFileAsync(binary, ["-version"], { timeout: 15_000 });
    return check({ id, label, status: "ok", detail: `${stdout.split("\n")[0]} (${origin}: ${binary})`, required: true });
  } catch (error) {
    return check({
      id,
      label,
      status: "fail",
      detail: `${binary} did not run: ${message(error)}`,
      remedy: `${INSTALL_REMEDY}, install ${label} on PATH, or set ${envName}.`,
      required: true,
    });
  }
}

function cookiesDetail(cookies: YtdlpCookiesSetting | null): string {
  if (!cookies) return "not set";
  return cookies.readable ? cookies.path : `${cookies.path} (not readable)`;
}

async function ytdlpCheck(): Promise<DoctorCheck> {
  const binary = resolveYtdlp();
  if (binary) {
    const origin = binary.source === "PATH" ? "from PATH" : binary.source;
    const targets = await ytdlpImpersonateTargets(binary.path);
    const cookies = ytdlpCookiesSetting();
    const unreadable = cookies !== null && !cookies.readable;
    return check({
      id: "yt-dlp",
      label: "yt-dlp",
      status: unreadable ? "warn" : "ok",
      detail: `${binary.path} (${origin}); impersonation: ${targets.join(", ") || "none"}; cookies: ${cookiesDetail(cookies)}`,
      ...(unreadable ? { remedy: "Point VIDEOBOOK_YTDLP_COOKIES at a readable Netscape cookies file, or unset it." } : {}),
      required: false,
    });
  }
  return check({
    id: "yt-dlp",
    label: "yt-dlp",
    status: "warn",
    detail: "not found; download_video and archive_clip from URLs will fail",
    remedy: `${INSTALL_REMEDY}, install yt-dlp on PATH, or set VIDEOBOOK_YTDLP_PATH.`,
    required: false,
  });
}

function sharedObjects(pattern: RegExp): string[] {
  const report = process.report.getReport() as { sharedObjects?: string[] };
  return (report.sharedObjects ?? []).filter((name) => pattern.test(name));
}

function engineRequire(): NodeJS.Require {
  return createRequire(require.resolve("videobook-engine/package.json"));
}

function nativeCoreCheck(): DoctorCheck {
  try {
    const { DatabaseSync } = engineRequire()("@dolthub/doltlite") as { DatabaseSync: new (path: string) => { doltVersion(): string; close(): void } };
    const database = new DatabaseSync(":memory:");
    const dolt = database.doltVersion();
    database.close();
    const sharp = require("sharp") as { versions: { sharp?: string; vips?: string } };
    const copies = sharedObjects(/sharp[^/\\]*\.node$/u).length;
    return check({
      id: "native-runtime",
      label: "Native modules",
      status: copies > 1 ? "fail" : "ok",
      detail: `DoltLite ${dolt}; Sharp ${sharp.versions.sharp ?? "?"} / libvips ${sharp.versions.vips ?? "?"}${copies > 1 ? `; ${copies} Sharp copies loaded` : ""}`,
      ...(copies > 1 ? { remedy: "Reinstall videobook so npm dedupes Sharp to one copy." } : {}),
      required: true,
    });
  } catch (error) {
    return check({ id: "native-runtime", label: "Native modules", status: "fail", detail: message(error), remedy: INSTALL_REMEDY, required: true });
  }
}

function searchRuntimeCheck(): DoctorCheck {
  const fromEngine = engineRequire();
  try {
    fromEngine("onnxruntime-node");
    fromEngine("usearch");
    return check({ id: "search-runtime", label: "Semantic search", status: "ok", detail: "ONNX Runtime and USearch load", required: false });
  } catch (error) {
    return check({
      id: "search-runtime",
      label: "Semantic search",
      status: "warn",
      detail: `unavailable on ${process.platform}-${process.arch}: ${message(error)}`,
      required: false,
    });
  }
}

async function renderBrowserCheck(): Promise<DoctorCheck> {
  const root = remotionCacheRoot();
  if (!root) {
    return check({ id: "render-browser", label: "Render browser", status: "ok", detail: "managed by Remotion in this source checkout", required: false });
  }
  const directory = remotionBrowserDir(root);
  try {
    await access(join(directory, "chrome-headless-shell"));
    return check({ id: "render-browser", label: "Render browser", status: "ok", detail: `Chrome Headless Shell in ${directory}`, required: false });
  } catch {
    return check({
      id: "render-browser",
      label: "Render browser",
      status: "warn",
      detail: `not downloaded yet; the first render downloads Chrome Headless Shell into ${directory}`,
      required: false,
    });
  }
}

async function opVersion(): Promise<string | null> {
  try {
    return (await execFileAsync("op", ["--version"], { timeout: 10_000 })).stdout.trim();
  } catch {
    return null;
  }
}

function describeResolution(resolution: OnePasswordResolution): string {
  const filled = resolution.fromReferences.length + resolution.fromVault.length;
  const vault = resolution.vault ? `vault ${resolution.vault}` : "op:// references";
  const token = resolution.tokenSource ? `token ${resolution.tokenSource}` : "op's own sign-in";
  return `${vault}, ${token}: ${filled} key(s) from 1Password`;
}

function unresolvedDetail(resolution: OnePasswordResolution): string {
  const failures = resolution.unresolved.map((item) => `${item.key} from ${item.reference} (${item.reason})`);
  return [resolution.error, ...failures].filter((part): part is string => Boolean(part)).join("; ");
}

async function onePasswordCheck(): Promise<DoctorCheck> {
  const resolution = getDefaultSecretStore().onePasswordResolution();
  const version = await opVersion();
  const cli = version ? `op ${version}` : "op not on PATH";
  if (!resolution?.attempted) {
    const tokenSource = readOnePasswordSettings(process.env).token.source;
    const token = tokenSource ? `token ${tokenSource}, ` : "";
    return check({ id: "one-password", label: "1Password", status: "ok", detail: `not used (${token}${cli}); to read keys from a vault: videobook setup 1password --op-vault <vault>`, required: false });
  }
  const problems = unresolvedDetail(resolution);
  return check({
    id: "one-password",
    label: "1Password",
    status: problems ? "warn" : "ok",
    detail: `${describeResolution(resolution)}${problems ? `; unresolved: ${problems}` : ""} (${cli})`,
    ...(problems ? { remedy: "Check the references and the service-account token, or run videobook setup 1password again." } : {}),
    required: false,
  });
}

function providerKeysCheck(): DoctorCheck {
  const store = getDefaultSecretStore();
  const configured = MANAGED_ENV_KEYS.filter((key) => key.endsWith("_API_KEY") && store.getSource(key) !== "missing");
  if (configured.length === 0) {
    return check({
      id: "provider-keys",
      label: "Provider keys",
      status: "warn",
      detail: "none configured; generation and transcription tools will fail",
      remedy: `Add keys such as OPENAI_API_KEY to ${dataLayout().envPath} or the environment.`,
      required: false,
    });
  }
  const shown = configured.map((key) => `${key} (${store.getSource(key)})`);
  return check({ id: "provider-keys", label: "Provider keys", status: "ok", detail: shown.join(", "), required: false });
}

async function ownerCheck(port: number): Promise<DoctorCheck> {
  const owner = await inspectServerOwner(bookManager.rootDir);
  if (owner.kind === "running") {
    return check({ id: "owner", label: "Server", status: "ok", detail: `running at ${owner.record.url} (pid ${owner.record.pid})`, required: false });
  }
  if (owner.kind === "unresponsive") {
    return check({ id: "owner", label: "Server", status: "warn", detail: `pid ${owner.record.pid} holds the library but does not answer at ${owner.record.url}`, required: false });
  }
  return check({ id: "owner", label: "Server", status: "ok", detail: `not running (videobook serve listens on 127.0.0.1:${port})`, required: false });
}

async function collectDoctorChecks(): Promise<DoctorCheck[]> {
  return [
    nodeCheck(),
    await dataHomeCheck(),
    await harCaptureCheck(),
    await libraryCheck(),
    await binaryCheck("ffmpeg", "ffmpeg", FFMPEG, bundledPath("ffmpeg-static"), "VIDEOBOOK_FFMPEG_PATH"),
    await binaryCheck("ffprobe", "ffprobe", FFPROBE, bundledFfprobe(), "VIDEOBOOK_FFPROBE_PATH"),
    await ytdlpCheck(),
    nativeCoreCheck(),
    searchRuntimeCheck(),
    await renderBrowserCheck(),
    await onePasswordCheck(),
    providerKeysCheck(),
    await ownerCheck(resolvePort(process.env)),
  ];
}

function statusLabel(status: CheckStatus): string {
  return status === "ok" ? "ok  " : status === "warn" ? "warn" : "FAIL";
}

function renderText(checks: DoctorCheck[]): string {
  const lines = checks.flatMap((item) => [
    `${statusLabel(item.status)}  ${item.label.padEnd(16)} ${item.detail}`,
    ...(item.remedy && item.status !== "ok" ? [`      ${"".padEnd(16)} fix: ${item.remedy}`] : []),
  ]);
  return `${lines.join("\n")}\n`;
}

function doctorExitCode(checks: DoctorCheck[]): number {
  return checks.some((item) => item.required && item.status === "fail") ? 1 : 0;
}

export async function runDoctorCommand(flags: DoctorFlags): Promise<number> {
  getDefaultSecretStore().resolveOnePassword();
  const checks = await collectDoctorChecks();
  const code = doctorExitCode(checks);
  process.stdout.write(flags.json ? `${JSON.stringify({ ok: code === 0, checks }, null, 2)}\n` : renderText(checks));
  return code;
}
