import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { remotionBrowserDir, remotionCacheRoot, renderBrowserExecutable } from "./browser.js";
import { testBudget } from "../test-budget.js";

const repoBrowser = resolve(import.meta.dirname, "../../../node_modules/.remotion");
const previousOverride = process.env.VIDEOBOOK_REMOTION_CACHE_DIR;

describe("remotion render browser location", () => {
  const roots: string[] = [];

  afterEach(async () => {
    if (previousOverride === undefined) delete process.env.VIDEOBOOK_REMOTION_CACHE_DIR;
    else process.env.VIDEOBOOK_REMOTION_CACHE_DIR = previousOverride;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("keeps Remotion's own location in a source checkout and pins installed packages to the user cache", () => {
    expect(remotionCacheRoot({}, "/repo")).toBeNull();
    expect(remotionCacheRoot({}, null)).toBe(join(homedir(), ".cache", "videobook", "remotion"));
    expect(remotionCacheRoot({ VIDEOBOOK_REMOTION_CACHE_DIR: " /data/remotion " }, "/repo")).toBe("/data/remotion");
    expect(remotionBrowserDir("/data/remotion")).toBe(join("/data/remotion", "node_modules", ".remotion"));
  });

  it("leaves the browser choice to Remotion when running from this checkout", async () => {
    delete process.env.VIDEOBOOK_REMOTION_CACHE_DIR;
    await expect(renderBrowserExecutable()).resolves.toBeUndefined();
  });

  it.skipIf(!existsSync(join(repoBrowser, "chrome-headless-shell")))("finds a browser already present in a pinned cache without downloading", async () => {
    const root = await mkdtemp(join(tmpdir(), "vb-remotion-cache-"));
    roots.push(root);
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(repoBrowser, remotionBrowserDir(root), "dir");
    process.env.VIDEOBOOK_REMOTION_CACHE_DIR = root;
    const executable = await renderBrowserExecutable();
    expect(executable).toBeDefined();
    await access(executable ?? "");
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual({ name: "videobook-remotion-cache", private: true });
  }, testBudget(60_000));
});
