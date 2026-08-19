import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { currentTestLabel, formatBlockedFetchError } from "./test-fetch-guard.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const vitestCli = join(
  dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
  "vitest.mjs",
);

async function runVitest(
  cwd: string,
  configPath: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      [vitestCli, "run", "--config", configPath],
      {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, VITEST: "true" },
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      code: typeof failed.code === "number" ? failed.code : 1,
    };
  }
}

describe("vitest quiet policy", () => {
  it("declares silent passed-only in both vitest configs", async () => {
    const rootConfig = await readFile(join(repoRoot, "vitest.config.ts"), "utf8");
    const e2eConfig = await readFile(join(repoRoot, "vitest.e2e.config.ts"), "utf8");
    expect(rootConfig).toContain("silent: 'passed-only'");
    expect(e2eConfig).toContain("silent: 'passed-only'");
    expect(rootConfig).toContain("BENIGN_TEST_CONSOLE_PREFIXES");
    expect(rootConfig).toMatch(/'\[mcp] '/);
  });
});

describe("fetch-guard attribution", () => {
  it("names the current test and file", () => {
    expect(currentTestLabel({
      currentTestName: "blocks example.com",
      testPath: "/tmp/repo/server/src/foo.test.ts",
    })).toBe("src/foo.test.ts :: blocks example.com");
  });

  it("falls back to the last completed test between tests", () => {
    expect(currentTestLabel({
      currentTestName: undefined,
      testPath: "/tmp/repo/server/src/foo.test.ts",
    }, "previous case")).toBe("src/foo.test.ts :: between tests (last: previous case)");
  });

  it("includes host and test label in the thrown message", () => {
    expect(formatBlockedFetchError([
      { host: "example.com", testLabel: "src/foo.test.ts :: offender" },
    ])).toBe(
      "[test guard] outbound API fetch attempted during test: example.com (test: src/foo.test.ts :: offender)",
    );
  });
});

describe("vitest silent probe", () => {
  it("hides passing-test logs and keeps failing-test logs", async () => {
    const { stdout, stderr, code } = await runVitest(
      repoRoot,
      join(repoRoot, "server/src/quiet-probes/vitest.silent.config.ts"),
    );
    const output = `${stdout}\n${stderr}`;
    expect(code).not.toBe(0);
    expect(output).not.toContain("[probe-pass] should stay hidden");
    expect(output).toContain("[probe-fail] should stay visible");
  });
});

describe("fetch-guard probe", () => {
  it("fails the offending test with its name and host", async () => {
    const { stdout, stderr, code } = await runVitest(
      repoRoot,
      join(repoRoot, "server/src/quiet-probes/vitest.fetch.config.ts"),
    );
    const output = `${stdout}\n${stderr}`;
    expect(code).not.toBe(0);
    expect(output).toContain("example.com");
    expect(output).toContain("offender");
    expect(output).toContain("[test guard]");
  });
});
