import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "dotenv";
import { afterEach, describe, expect, it } from "vitest";
import { applyEnvUpdates, formatEnvValue, updateEnvFile } from "./env-file.js";

describe("applyEnvUpdates", () => {
  it("replaces the last assignment, appends new keys and removes deleted ones", () => {
    const raw = "# keys\nA=1\nexport B=2\nA=3\nC=4\n";
    expect(applyEnvUpdates(raw, { A: "9", B: null, D: "new value" })).toBe("# keys\nA=1\nA=9\nC=4\nD='new value'\n");
  });

  it("handles empty files and files without a trailing newline", () => {
    expect(applyEnvUpdates("", { A: "1" })).toBe("A=1\n");
    expect(applyEnvUpdates("A=1", { B: "2" })).toBe("A=1\nB=2\n");
    expect(applyEnvUpdates("A=1\n", { A: null })).toBe("");
  });

  it("quotes values so dotenv reads them back unchanged", () => {
    for (const value of ["plain", "has space", "has#hash", "it's", "say \"hi\"", "op://Apicity/X/password"]) {
      expect(parse(`K=${formatEnvValue(value)}\n`).K).toBe(value);
    }
    expect(() => formatEnvValue("both ' and \"")).toThrow("both single and double quotes");
  });

  it("rejects invalid variable names", () => {
    expect(() => applyEnvUpdates("", { "BAD-NAME": "x" })).toThrow("not a valid environment variable name");
  });
});

describe("updateEnvFile", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("creates the file privately and keeps an existing file's mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "vb-env-file-"));
    roots.push(root);
    const created = join(root, "home", ".env");
    await updateEnvFile(created, { A: "1" });
    expect(await readFile(created, "utf8")).toBe("A=1\n");
    expect((await stat(created)).mode & 0o777).toBe(0o600);

    const existing = join(root, "existing.env");
    await writeFile(existing, "B=2\n", { mode: 0o640 });
    await updateEnvFile(existing, { C: "3" });
    expect(await readFile(existing, "utf8")).toBe("B=2\nC=3\n");
    expect((await stat(existing)).mode & 0o777).toBe(0o640);
  });
});
