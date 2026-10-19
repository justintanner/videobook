import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dataLayout, sourceCheckoutRoot } from "./data-home.js";

describe("dataLayout", () => {
  it("defaults an installed package to ~/.videobook", () => {
    const root = join(homedir(), ".videobook");
    expect(dataLayout({}, "/work", null)).toEqual({
      kind: "home",
      root,
      libraryDir: join(root, "books"),
      appStatePath: join(root, "app-state.json"),
      envPath: join(root, ".env"),
    });
  });

  it("keeps the repository layout when running from a source checkout", () => {
    expect(dataLayout({}, "/work", "/repo")).toEqual({
      kind: "checkout",
      root: "/repo",
      libraryDir: join("/repo", "books"),
      appStatePath: join("/repo", "runtime", "app-state.json"),
      envPath: join("/repo", ".env"),
    });
  });

  it("lets VIDEOBOOK_HOME win and resolves a relative value against cwd", () => {
    expect(dataLayout({ VIDEOBOOK_HOME: "/data/vb" }, "/work", "/repo")).toEqual({
      kind: "home",
      root: "/data/vb",
      libraryDir: join("/data/vb", "books"),
      appStatePath: join("/data/vb", "app-state.json"),
      envPath: join("/data/vb", ".env"),
    });
    expect(dataLayout({ VIDEOBOOK_HOME: "  rel/home  " }, "/work", null).root).toBe(join("/work", "rel", "home"));
  });

  it("ignores a blank VIDEOBOOK_HOME", () => {
    expect(dataLayout({ VIDEOBOOK_HOME: "   " }, "/work", null).root).toBe(join(homedir(), ".videobook"));
    expect(dataLayout({ VIDEOBOOK_HOME: "" }, "/work", "/repo").kind).toBe("checkout");
  });
});

describe("sourceCheckoutRoot", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("recognizes this repository from the module location", () => {
    expect(sourceCheckoutRoot()).toBe(resolve(import.meta.dirname, "../.."));
  });

  it("only accepts the private workspace package two levels up", async () => {
    const root = await mkdtemp(join(tmpdir(), "vb-data-home-"));
    roots.push(root);
    await mkdir(join(root, "server", "dist"), { recursive: true });
    const moduleUrl = pathToFileURL(join(root, "server", "dist", "data-home.js")).href;
    expect(sourceCheckoutRoot(moduleUrl)).toBeNull();
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "videobook" }));
    expect(sourceCheckoutRoot(moduleUrl)).toBeNull();
    await writeFile(join(root, "package.json"), "not json");
    expect(sourceCheckoutRoot(moduleUrl)).toBeNull();
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "videobook-workspace" }));
    expect(sourceCheckoutRoot(moduleUrl)).toBe(root);
  });
});
