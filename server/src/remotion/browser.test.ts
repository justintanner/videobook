import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { remotionBrowserDir, remotionCacheRoot, renderBrowserExecutable } from "./browser.js";
import { testBudget } from "../test-budget.js";

const require = createRequire(import.meta.url);
const previousOverride = process.env.VIDEOBOOK_REMOTION_CACHE_DIR;
const previousNodeOptions = process.env.NODE_OPTIONS;

describe("remotion render browser location", () => {
  const roots: string[] = [];

  afterEach(async () => {
    if (previousOverride === undefined) delete process.env.VIDEOBOOK_REMOTION_CACHE_DIR;
    else process.env.VIDEOBOOK_REMOTION_CACHE_DIR = previousOverride;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
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

  it("finds a browser already present in a pinned cache without downloading", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vb-remotion-cache-")));
    roots.push(root);
    const { TESTED_VERSION, getRevisionInfo } = require(join(dirname(require.resolve("@remotion/renderer")), "browser", "BrowserFetcher.js")) as {
      TESTED_VERSION: string;
      getRevisionInfo: (mode: "headless-shell") => { executablePath: string };
    };
    const browserPath = relative(remotionBrowserDir(process.cwd()), getRevisionInfo("headless-shell").executablePath);
    expect(browserPath.startsWith("chrome-headless-shell")).toBe(true);
    const cachedExecutable = join(remotionBrowserDir(root), browserPath);
    await mkdir(dirname(cachedExecutable), { recursive: true });
    await symlink(process.execPath, cachedExecutable, "file");
    await writeFile(join(remotionBrowserDir(root), "chrome-headless-shell", "VERSION"), TESTED_VERSION);
    const networkGuard = join(root, "no-network.mjs");
    await writeFile(networkGuard, 'import { Socket } from "node:net";\nSocket.prototype.connect = () => { throw new Error("Browser lookup must not access the network"); };\n');
    process.env.NODE_OPTIONS = [previousNodeOptions, "--import", pathToFileURL(networkGuard).href].filter(Boolean).join(" ");
    process.env.VIDEOBOOK_REMOTION_CACHE_DIR = root;
    const executable = await renderBrowserExecutable();
    expect(executable).toBe(cachedExecutable);
    await access(executable ?? "");
    expect(await realpath(cachedExecutable)).toBe(await realpath(process.execPath));
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual({ name: "videobook-remotion-cache", private: true });
  }, testBudget(60_000));
});
