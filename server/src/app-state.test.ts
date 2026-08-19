import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_APPLICATION_STATE_PATH,
  resolveApplicationStatePath,
} from "./app-state.js";

describe("resolveApplicationStatePath", () => {
  const cwd = "/Users/jwt/videobook";

  it("uses the documented default file when the env var is unset", () => {
    expect(resolveApplicationStatePath(undefined, cwd)).toBe(
      join(cwd, DEFAULT_APPLICATION_STATE_PATH),
    );
  });

  it("uses the documented default file when the env var is empty", () => {
    expect(resolveApplicationStatePath("", cwd)).toBe(
      join(cwd, DEFAULT_APPLICATION_STATE_PATH),
    );
  });

  it("uses the documented default file when the env var is whitespace-only", () => {
    expect(resolveApplicationStatePath("   \n\t  ", cwd)).toBe(
      join(cwd, DEFAULT_APPLICATION_STATE_PATH),
    );
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
