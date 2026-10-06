import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  FFPROBE,
  binaryRunsOnHost,
  machOArch,
  resolveFfprobePath,
} from "./ffprobe-binary.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const bundledFfprobe: string = require("ffprobe-static").path;
const bundledFfmpeg: string = require("ffmpeg-static");

function machOHeader(cpuType: number): Uint8Array {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setUint32(4, cpuType, true);
  return header;
}

describe("ffprobe binary resolution", () => {
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
    expect(resolveFfprobePath(bundledFfprobe, "/custom/ffprobe", process.arch)).toBe("/custom/ffprobe");
    const ffmpegHeader = new Uint8Array(await readFile(bundledFfmpeg)).subarray(0, 8);
    const foreignArch = machOArch(ffmpegHeader) === "arm64" ? "x64" : "arm64";
    if (machOArch(ffmpegHeader) === "arm64" || machOArch(ffmpegHeader) === "x64") {
      expect(resolveFfprobePath(bundledFfmpeg, undefined, foreignArch)).toBe("ffprobe");
      expect(resolveFfprobePath(bundledFfmpeg, undefined, process.arch)).toBe(bundledFfmpeg);
    }
    expect(resolveFfprobePath("/missing/ffprobe", undefined, process.arch)).toBe("ffprobe");
  });

  it("resolves an ffprobe that runs on this machine", async () => {
    const { stdout } = await execFileAsync(FFPROBE, ["-version"]);
    expect(stdout).toMatch(/^ffprobe version/u);
  });
});
