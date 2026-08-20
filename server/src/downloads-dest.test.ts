import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generationLabel } from "./artifact-label.js";
import { resolveDownloadDestination } from "./downloads-dest.js";

describe("resolveDownloadDestination", () => {
  let downloads: string | undefined;

  afterEach(async () => {
    if (!downloads) return;
    await rm(downloads, { recursive: true, force: true, maxRetries: 3 });
    downloads = undefined;
  });

  async function downloadsDir(): Promise<string> {
    downloads = await mkdtemp(join(tmpdir(), "downloads-dest-"));
    return downloads;
  }

  it("keeps a slashy generationLabel as one file in Downloads", async () => {
    const dir = await downloadsDir();
    const label = generationLabel("kling-3.0/video", "a cat dancing");
    expect(label).toContain("/");
    const dest = await resolveDownloadDestination(label, ".srt", dir);
    expect(dirname(dest)).toBe(dir);
    expect(basename(dest)).not.toMatch(/[/\\]/);
    expect(basename(dest).endsWith(".srt")).toBe(true);
    expect(basename(dest)).toContain("kling-3.0");
    expect(basename(dest)).toContain("a cat dancing");
    await writeFile(dest, "cue", "utf8");
    expect(await readdir(dir)).toEqual([basename(dest)]);
  });

  it("drops .. path segments and backslashes so dest cannot escape Downloads", async () => {
    const dir = await downloadsDir();
    const dest = await resolveDownloadDestination(
      "..\\..\\secret/file",
      ".srt",
      dir,
    );
    expect(dirname(dest)).toBe(dir);
    expect(basename(dest)).toBe("secret - file.srt");
    expect(dest.includes("..")).toBe(false);
  });
});
