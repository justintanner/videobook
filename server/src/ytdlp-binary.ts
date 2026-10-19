import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, isAbsolute, join } from "node:path";
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

const YTDLP_OVERRIDE = "VIDEOBOOK_YTDLP_PATH";
const require = createRequire(import.meta.url);

export const YTDLP_MISSING_MESSAGE =
  "yt-dlp is not installed. Put yt-dlp on PATH (for example brew install yt-dlp), set VIDEOBOOK_YTDLP_PATH, "
  + "or reinstall with npm install -g videobook --allow-scripts=ffmpeg-static,ytdlp-nodejs,@dolthub/doltlite,usearch,onnxruntime-node,esbuild";

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
