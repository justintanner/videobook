import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  FFPROBE,
  binaryRunsOnHost,
  bundledFfprobe,
  ensureExecutable,
  machOArch,
  resolveFfprobePath,
} from "./ffprobe-binary.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const installedFfprobe: string = (require("@ffprobe-installer/ffprobe") as { path: string }).path;
const bundledFfmpeg: string = require("ffmpeg-static");

function machOHeader(cpuType: number): Uint8Array {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setUint32(4, cpuType, true);
  return header;
}

describe("ffprobe binary resolution", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("reads the CPU type from Mach-O headers", () => {
    expect(machOArch(machOHeader(0x0100000c))).toBe("arm64");
    expect(machOArch(machOHeader(0x01000007))).toBe("x64");
    expect(machOArch(Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2))).toBe("universal");
    expect(machOArch(Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0))).toBeNull();
  });

  it("rejects only Mach-O binaries built for another CPU", () => {
    expect(binaryRunsOnHost(machOHeader(0x01000007), "arm64")).toBe(false);
    expect(binaryRunsOnHost(machOHeader(0x0100000c), "arm64")).toBe(true);
    expect(binaryRunsOnHost(Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0), "arm64")).toBe(true);
  });

  it("prefers an explicit override and falls back to PATH for a foreign build", async () => {
    expect(resolveFfprobePath(installedFfprobe, "/custom/ffprobe", process.arch)).toBe("/custom/ffprobe");
    expect(resolveFfprobePath(null, undefined, process.arch)).toBe("ffprobe");
    const ffmpegHeader = new Uint8Array(await readFile(bundledFfmpeg)).subarray(0, 8);
    const foreignArch = machOArch(ffmpegHeader) === "arm64" ? "x64" : "arm64";
    if (machOArch(ffmpegHeader) === "arm64" || machOArch(ffmpegHeader) === "x64") {
      expect(resolveFfprobePath(bundledFfmpeg, undefined, foreignArch)).toBe("ffprobe");
      expect(resolveFfprobePath(bundledFfmpeg, undefined, process.arch)).toBe(bundledFfmpeg);
    }
    expect(resolveFfprobePath("/missing/ffprobe", undefined, process.arch)).toBe("ffprobe");
  });

  it("marks a bundled binary executable when npm skipped its chmod script", async () => {
    const root = await mkdtemp(join(tmpdir(), "vb-ffprobe-binary-"));
    roots.push(root);
    const binary = join(root, "ffprobe");
    await writeFile(binary, "#!/bin/sh\necho ffprobe version test\n", { mode: 0o644 });
    expect(ensureExecutable(binary)).toBe(true);
    expect((await stat(binary)).mode & 0o111).toBe(0o111);
    expect((await execFileAsync(binary, [])).stdout).toBe("ffprobe version test\n");
    expect(ensureExecutable(join(root, "missing"))).toBe(false);
  });

  it("bundles a native ffprobe build for this platform", async () => {
    expect(bundledFfprobe()).toBe(installedFfprobe);
    const arch = machOArch(new Uint8Array(await readFile(installedFfprobe)).subarray(0, 8));
    expect(arch === null || arch === "universal" || arch === process.arch).toBe(true);
    expect(resolveFfprobePath(installedFfprobe, undefined, process.arch)).toBe(installedFfprobe);
    const { stdout } = await execFileAsync(installedFfprobe, ["-version"]);
    expect(stdout).toMatch(/^ffprobe version/u);
  });

  it("resolves an ffprobe that runs on this machine", async () => {
    const { stdout } = await execFileAsync(FFPROBE, ["-version"]);
    expect(stdout).toMatch(/^ffprobe version/u);
  });
});
