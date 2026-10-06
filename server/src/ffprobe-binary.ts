import { closeSync, openSync, readSync } from "node:fs";
import { createRequire } from "node:module";

/** CPU a Mach-O header targets; `universal` covers fat binaries. */
export type MachOArch = "arm64" | "x64" | "universal" | "other";

const MACH_O_64_MAGIC_LE = 0xfeedfacf;
const FAT_MAGIC_BE = 0xcafebabe;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

/** Reads the CPU type from a Mach-O header; null when it is not Mach-O. */
export function machOArch(header: Uint8Array): MachOArch | null {
  if (header.length < 8) return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, false) === FAT_MAGIC_BE) return "universal";
  if (view.getUint32(0, true) !== MACH_O_64_MAGIC_LE) return null;
  const cpuType = view.getUint32(4, true);
  if (cpuType === CPU_TYPE_ARM64) return "arm64";
  if (cpuType === CPU_TYPE_X86_64) return "x64";
  return "other";
}

/** Whether a binary with this header can run on the host CPU. */
export function binaryRunsOnHost(header: Uint8Array, hostArch: string): boolean {
  const arch = machOArch(header);
  return arch === null || arch === "universal" || arch === hostArch;
}

function readHeader(path: string): Uint8Array | null {
  try {
    const fd = openSync(path, "r");
    try {
      const header = new Uint8Array(8);
      return readSync(fd, header, 0, 8, 0) === 8 ? header : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * ffprobe-static ships an x86_64 build under darwin/arm64, which cannot spawn
 * on Apple Silicon without Rosetta. An explicit override wins; otherwise the
 * bundled binary is used only when its CPU matches, else `ffprobe` on PATH.
 */
export function resolveFfprobePath(
  bundledPath: string,
  override: string | undefined,
  hostArch: string,
): string {
  if (override) return override;
  const header = readHeader(bundledPath);
  return header && binaryRunsOnHost(header, hostArch) ? bundledPath : "ffprobe";
}

const require = createRequire(import.meta.url);

export const FFPROBE: string = resolveFfprobePath(
  require("ffprobe-static").path,
  process.env.VIDEOBOOK_FFPROBE_PATH,
  process.arch,
);
