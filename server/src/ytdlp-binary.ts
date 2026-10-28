import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { FFMPEG } from "./ffmpeg-binary.js";

export type YtdlpSource = "VIDEOBOOK_YTDLP_PATH" | "bundled" | "PATH";

export interface ResolvedYtdlp {
  path: string;
  source: YtdlpSource;
}

export interface YtdlpRunOptions {
  binaryPath: string;
  ffmpegPath?: string;
}

export interface YtdlpCookiesSetting {
  path: string;
  readable: boolean;
}

const YTDLP_OVERRIDE = "VIDEOBOOK_YTDLP_PATH";
const YTDLP_COOKIES = "VIDEOBOOK_YTDLP_COOKIES";
const IMPERSONATE_PROBE_TIMEOUT_MS = 15_000;
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const impersonateProbes = new Map<string, Promise<string[]>>();

export const YTDLP_MISSING_MESSAGE =
  "yt-dlp is not installed. Put yt-dlp on PATH (for example brew install yt-dlp), set VIDEOBOOK_YTDLP_PATH, "
  + "or reinstall with npm install -g videobook --allow-scripts=ffmpeg-static,ytdlp-nodejs,@dolthub/doltlite,usearch,onnxruntime-node,esbuild";

function isAccessibleFile(path: string, mode: number): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

function isExecutableFile(path: string): boolean {
  return isAccessibleFile(path, constants.X_OK);
}

function executableNames(name: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [name];
  const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  return [name, ...extensions.map((extension) => `${name}${extension.toLowerCase()}`)];
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const directories = (env.PATH ?? "").split(delimiter).filter((directory) => isAbsolute(directory));
  for (const directory of directories) {
    const match = executableNames(name, env).map((candidate) => join(directory, candidate)).find(isExecutableFile);
    if (match) return match;
  }
  return null;
}

export function bundledYtdlp(): string | null {
  try {
    const { helpers } = require("ytdlp-nodejs") as { helpers: { findYtdlpBinary(): string | undefined } };
    const path = helpers.findYtdlpBinary();
    return path && isExecutableFile(path) ? path : null;
  } catch {
    return null;
  }
}

export function resolveYtdlp(env: NodeJS.ProcessEnv = process.env, bundled: string | null = bundledYtdlp()): ResolvedYtdlp | null {
  const override = env[YTDLP_OVERRIDE]?.trim();
  if (override) return { path: override, source: "VIDEOBOOK_YTDLP_PATH" };
  if (bundled) return { path: bundled, source: "bundled" };
  const onPath = findOnPath("yt-dlp", env);
  return onPath ? { path: onPath, source: "PATH" } : null;
}

function ffmpegForYtdlp(env: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(FFMPEG)) return isExecutableFile(FFMPEG) ? FFMPEG : null;
  return findOnPath(FFMPEG, env);
}

export function ytdlpRunOptions(env: NodeJS.ProcessEnv = process.env, bundled: string | null = bundledYtdlp()): YtdlpRunOptions {
  const binary = resolveYtdlp(env, bundled);
  if (!binary) throw new Error(YTDLP_MISSING_MESSAGE);
  const ffmpeg = ffmpegForYtdlp(env);
  return { binaryPath: binary.path, ...(ffmpeg ? { ffmpegPath: ffmpeg } : {}) };
}

export function ytdlpCookiesSetting(env: NodeJS.ProcessEnv = process.env): YtdlpCookiesSetting | null {
  const path = env[YTDLP_COOKIES]?.trim();
  return path ? { path, readable: isAccessibleFile(path, constants.R_OK) } : null;
}

export function parseImpersonateTargets(output: string): string[] {
  const lines = output.split(/\r?\n/u);
  const header = lines.findIndex((line) => /^-{3,}$/u.test(line.trim()));
  if (header < 0) return [];
  const clients = lines.slice(header + 1).flatMap((line) => {
    const [target = "", , source = ""] = line.trim().split(/\s{2,}/u);
    const client = target.split("-")[0].toLowerCase();
    return client && source && !source.includes("unavailable") ? [client] : [];
  });
  return [...new Set(clients)].sort();
}

export function ytdlpImpersonateTargets(binaryPath: string): Promise<string[]> {
  const cached = impersonateProbes.get(binaryPath);
  if (cached) return cached;
  const probe = execFileAsync(binaryPath, ["--list-impersonate-targets"], { timeout: IMPERSONATE_PROBE_TIMEOUT_MS })
    .then(({ stdout }) => parseImpersonateTargets(stdout), () => []);
  impersonateProbes.set(binaryPath, probe);
  return probe;
}
