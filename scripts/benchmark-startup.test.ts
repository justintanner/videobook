import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { testBudget } from "../server/src/test-budget.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(repoRoot, "scripts", "benchmark-startup.ts");

interface BenchmarkSummary {
  rows: Array<{ phase: string; label: string; ms: number }>;
  perBook: Array<Record<string, unknown>>;
  rssMB: number;
  heapMB: number;
}

function runBenchmark(
  outPath: string,
  extraArgs: string[],
  libraryDir: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath, outPath, ...extraArgs],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          VIDEOBOOK_LIBRARY_DIR: libraryDir,
          VIDEOBOOK_DEV_FIXTURES: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

describe("benchmark:startup script", () => {
  it(
    "writes JSON with import, TIME-TO-LISTEN, and bookManager.ready rows, and fails budget flags",
    { timeout: testBudget(120_000) },
    async () => {
      const scratch = await mkdtemp(join(tmpdir(), "videobook-benchmark-"));
      const libraryDir = join(scratch, "books");
      const outPath = join(scratch, "startup.json");
      try {
        const pass = await runBenchmark(outPath, [], libraryDir);
        expect(pass.code, pass.stderr).toBe(0);
        const summary = JSON.parse(
          await readFile(outPath, "utf8"),
        ) as BenchmarkSummary;
        expect(summary.rows.some((row) => row.phase === "import")).toBe(true);
        expect(
          summary.rows.some((row) => row.label.includes("TIME-TO-LISTEN")),
        ).toBe(true);
        expect(
          summary.rows.some((row) => row.label.includes("bookManager.ready()")),
        ).toBe(true);

        const listenFailOut = join(scratch, "listen-fail.json");
        const listenFail = await runBenchmark(
          listenFailOut,
          ["--assert-listen-ms", "1"],
          libraryDir,
        );
        expect(listenFail.code).not.toBe(0);
        expect(listenFail.stderr).toMatch(/TIME-TO-LISTEN/);

        const readyFailOut = join(scratch, "ready-fail.json");
        const readyFail = await runBenchmark(
          readyFailOut,
          ["--assert-ready-ms", "0"],
          libraryDir,
        );
        expect(readyFail.code).not.toBe(0);
        expect(readyFail.stderr).toMatch(/bookManager\.ready\(\)/);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  );

  it("rejects unknown flags before importing the server", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "videobook-benchmark-flag-"));
    try {
      const bogus = join(scratch, "out.json");
      await writeFile(bogus, "");
      const result = await runBenchmark(bogus, ["--not-a-flag"], scratch);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/Unknown flag/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
