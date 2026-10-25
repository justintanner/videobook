import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { YtDlp } from "ytdlp-nodejs";
import { afterEach, describe, expect, it } from "vitest";
import { YTDLP_MISSING_MESSAGE, bundledYtdlp, findOnPath, resolveYtdlp, ytdlpRunOptions } from "./ytdlp-binary.js";
import { testBudget } from "./test-budget.js";

describe("yt-dlp binary resolution", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "vb-ytdlp-binary-"));
    roots.push(directory);
    return directory;
  }

  async function executable(directory: string, name: string, mode = 0o755): Promise<string> {
    await mkdir(directory, { recursive: true });
    const path = join(directory, name);
    await writeFile(path, "#!/bin/sh\necho 2099.01.01\n");
    await chmod(path, mode);
    return path;
  }

  it("finds executables on absolute PATH entries only", async () => {
    const base = await root();
    await executable(join(base, "not-executable"), "yt-dlp", 0o644);
    await mkdir(join(base, "directory", "yt-dlp"), { recursive: true });
    const found = await executable(join(base, "bin"), "yt-dlp");
    const path = ["relative/bin", join(base, "not-executable"), join(base, "directory"), join(base, "bin")].join(delimiter);
    expect(findOnPath("yt-dlp", { PATH: path })).toBe(found);
    expect(findOnPath("yt-dlp", { PATH: join(base, "not-executable") })).toBeNull();
    expect(findOnPath("yt-dlp", {})).toBeNull();
  });

  it("prefers VIDEOBOOK_YTDLP_PATH, then the bundled binary, then PATH", async () => {
    const base = await root();
    const bundled = await executable(join(base, "bundled"), "yt-dlp_bundled");
    const onPath = await executable(join(base, "bin"), "yt-dlp");
    const env: NodeJS.ProcessEnv = { PATH: join(base, "bin") };
    expect(resolveYtdlp({ ...env, VIDEOBOOK_YTDLP_PATH: "/custom/yt-dlp" }, bundled)).toEqual({ path: "/custom/yt-dlp", source: "VIDEOBOOK_YTDLP_PATH" });
    expect(resolveYtdlp({ ...env, VIDEOBOOK_YTDLP_PATH: " " }, bundled)).toEqual({ path: bundled, source: "bundled" });
    expect(resolveYtdlp(env, null)).toEqual({ path: onPath, source: "PATH" });
    expect(resolveYtdlp({ PATH: join(base, "empty") }, null)).toBeNull();
  });

  it("explains how to install yt-dlp when none is available", () => {
    expect(() => ytdlpRunOptions({ PATH: "" }, null)).toThrow(YTDLP_MISSING_MESSAGE);
    expect(YTDLP_MISSING_MESSAGE).toContain("VIDEOBOOK_YTDLP_PATH");
  });

  it("hands yt-dlp an absolute ffmpeg so merges work without ffmpeg on PATH", async () => {
    const base = await root();
    const onPath = await executable(join(base, "bin"), "yt-dlp");
    const options = ytdlpRunOptions({ PATH: [join(base, "bin"), process.env.PATH ?? ""].join(delimiter) }, null);
    expect(options.binaryPath).toBe(onPath);
    expect(options.ffmpegPath && isAbsolute(options.ffmpegPath)).toBe(true);
  });

  it("runs the yt-dlp that resolves on this machine through ytdlp-nodejs", async () => {
    const options = ytdlpRunOptions(process.env, bundledYtdlp());
    const version = await new YtDlp(options).getVersionAsync();
    expect(version).toMatch(/^\d{4}\.\d{2}\.\d{2}/u);
  }, testBudget(60_000));
});
