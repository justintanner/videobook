import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FFMPEG, resolveFfmpegPath } from "./ffmpeg-binary.js";
import { machOArch } from "./ffprobe-binary.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const bundledFfmpeg: string = require("ffmpeg-static");

describe("ffmpeg binary resolution", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("prefers an explicit override", () => {
    expect(resolveFfmpegPath(bundledFfmpeg, "/custom/ffmpeg", process.arch)).toBe("/custom/ffmpeg");
  });

  it("falls back to ffmpeg on PATH when the bundled binary is missing", () => {
    expect(resolveFfmpegPath("/missing/ffmpeg", undefined, process.arch)).toBe("ffmpeg");
    expect(resolveFfmpegPath(null, undefined, process.arch)).toBe("ffmpeg");
    expect(resolveFfmpegPath(null, "", process.arch)).toBe("ffmpeg");
  });

  it("falls back when the bundled path is an empty placeholder", async () => {
    const root = await mkdtemp(join(tmpdir(), "vb-ffmpeg-binary-"));
    roots.push(root);
    const placeholder = join(root, "ffmpeg");
    await writeFile(placeholder, "");
    expect(resolveFfmpegPath(placeholder, undefined, process.arch)).toBe("ffmpeg");
  });

  it("keeps the bundled binary only when it runs on the host CPU", async () => {
    const arch = machOArch(new Uint8Array(await readFile(bundledFfmpeg)).subarray(0, 8));
    if (arch === "arm64" || arch === "x64") {
      const foreignArch = arch === "arm64" ? "x64" : "arm64";
      expect(resolveFfmpegPath(bundledFfmpeg, undefined, foreignArch)).toBe("ffmpeg");
    }
    expect(resolveFfmpegPath(bundledFfmpeg, undefined, process.arch)).toBe(bundledFfmpeg);
  });

  it("resolves an ffmpeg that runs on this machine", async () => {
    const { stdout } = await execFileAsync(FFMPEG, ["-version"]);
    expect(stdout).toMatch(/^ffmpeg version/u);
  });
});
