import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileApplicationState,
  resolveApplicationStatePath,
} from "./app-state.js";
import { dataLayout } from "./data-home.js";

describe("resolveApplicationStatePath", () => {
  const cwd = "/Users/jwt/videobook";
  const fallback = "/home/user/.videobook/app-state.json";

  it("uses the data-home default file when the env var is unset", () => {
    expect(resolveApplicationStatePath(undefined, cwd, fallback)).toBe(fallback);
    expect(resolveApplicationStatePath(undefined, cwd)).toBe(dataLayout(process.env, cwd).appStatePath);
  });

  it("uses the data-home default file when the env var is empty", () => {
    expect(resolveApplicationStatePath("", cwd, fallback)).toBe(fallback);
  });

  it("uses the data-home default file when the env var is whitespace-only", () => {
    expect(resolveApplicationStatePath("   \n\t  ", cwd, fallback)).toBe(fallback);
  });

  it("resolves a relative path against the given cwd", () => {
    expect(resolveApplicationStatePath("runtime/custom-state.json", cwd)).toBe(
      join(cwd, "runtime/custom-state.json"),
    );
    expect(resolveApplicationStatePath("  state.json  ", cwd)).toBe(
      join(cwd, "state.json"),
    );
  });

  it("keeps an explicit absolute path", () => {
    expect(resolveApplicationStatePath("/var/videobook/app-state.json", cwd)).toBe(
      "/var/videobook/app-state.json",
    );
    expect(resolveApplicationStatePath("  /tmp/app-state.json  ", cwd)).toBe(
      "/tmp/app-state.json",
    );
  });
});

describe("FileApplicationState path selection", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 3 })));
  });

  it("writes through the resolved explicit path and can be re-read", async () => {
    const root = join(tmpdir(), `vb-app-state-${Date.now()}`);
    roots.push(root);
    const path = resolveApplicationStatePath(join(root, "app-state.json"));
    await mkdir(root, { recursive: true });
    await writeFile(path, JSON.stringify({ values: { token: "kept" } }), "utf8");
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual({ values: { token: "kept" } });
    expect(path.endsWith("app-state.json")).toBe(true);
    expect(path.startsWith(root)).toBe(true);
  });
});

describe("createFileApplicationState", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 3 })));
  });

  function makeStore() {
    const root = join(tmpdir(), `vb-app-state-${randomUUID()}`);
    roots.push(root);
    const path = join(root, "app-state.json");
    return { path, store: createFileApplicationState(path) };
  }

  it("reads null before the file exists and persists values through set", async () => {
    const { path, store } = makeStore();
    expect(await store.get("x.oauth.tokens")).toBeNull();
    await store.set("x.oauth.tokens", { access_token: "a" });
    expect(await store.get<{ access_token: string }>("x.oauth.tokens"))
      .toEqual({ access_token: "a" });
    expect(JSON.parse(await readFile(path, "utf8")))
      .toEqual({ values: { "x.oauth.tokens": { access_token: "a" } } });
  });

  it("sees tokens another process writes to the file after the first read", async () => {
    // scripts/mint-x-token.mjs writes the file while the server is running;
    // the server must not serve a cached "no tokens" answer afterwards.
    const { path, store } = makeStore();
    expect(await store.get("x.oauth.tokens")).toBeNull();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ values: { "x.oauth.tokens": { access_token: "minted" } } }),
      "utf8",
    );
    expect(await store.get<{ access_token: string }>("x.oauth.tokens"))
      .toEqual({ access_token: "minted" });
  });

  it("keeps keys written by other processes when it sets its own", async () => {
    const { path, store } = makeStore();
    await store.set("first", 1);
    await writeFile(
      path,
      JSON.stringify({ values: { first: 1, external: "kept" } }),
      "utf8",
    );
    await store.set("second", 2);
    expect(JSON.parse(await readFile(path, "utf8")))
      .toEqual({ values: { first: 1, external: "kept", second: 2 } });
  });
});
