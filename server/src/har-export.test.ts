import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarCapture, type Har } from "@apicity/har";
import { exportHarCaptures, type HarExportManifest } from "./har-export.js";
import { readHarIndex } from "./har-index.js";
import { installedPackageVersion } from "./package-version.js";

const exec = promisify(execFile);
const LONG_ENDPOINT = "post.queue.fal-ai/an-unusually-long-model-family/with-several-path-segments/image-to-video";

type Call = { provider: string; endpoint: string; path: "/ok" | "/fail"; at: string };

const CALLS: Call[] = [
  { provider: "kie", endpoint: "post.api.v1.jobs.createTask", path: "/ok", at: "2026-10-01T10:00:00.000Z" },
  { provider: "kie", endpoint: "post.api.v1.jobs.createTask", path: "/fail", at: "2026-10-02T10:00:00.000Z" },
  { provider: "fal", endpoint: "post.queue.submit", path: "/fail", at: "2026-10-03T10:00:00.000Z" },
  { provider: "fal", endpoint: LONG_ENDPOINT, path: "/ok", at: "2026-10-04T10:00:00.000Z" },
];

async function tree(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.set(relative(dir, path).split("\\").join("/"), await readFile(path, "utf8"));
    }
  }
  await walk(dir);
  return files;
}

describe("videobook har export", () => {
  let root: string;
  let dir: string;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-har-export-"));
    dir = join(root, "har");
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.statusCode = req.url === "/fail" ? 422 : 200;
        res.end(JSON.stringify(req.url === "/fail" ? { detail: "duration must be 5 or 10" } : { request_id: "req-1" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    url = `http://127.0.0.1:${address.port}`;
    for (const call of CALLS) {
      const capture = createHarCapture({ dir, mode: "all", clock: () => Date.parse(call.at), context: { bookId: "book-1", artifactId: call.at } });
      await capture.call({ provider: call.provider, endpoint: call.endpoint, input: { prompt: "a fox", api_key: "sk-input-secret" } }, async () => {
        const response = await capture.fetch(`${url}${call.path}`, {
          method: "POST",
          headers: { authorization: "Bearer sk-live-secret-123", "content-type": "application/json" },
          body: JSON.stringify({ prompt: "a fox" }),
        });
        await response.text();
        if (!response.ok) throw Object.assign(new Error("duration must be 5 or 10"), { status: response.status });
      }).catch(() => undefined);
      await capture.close();
    }
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("copies every capture byte for byte with an index and a manifest", async () => {
    const out = join(root, "export");
    const result = await exportHarCaptures({ dir, out, now: new Date("2026-10-24T12:00:00.000Z") });
    expect(result.status).toBe("exported");
    if (result.status !== "exported") return;
    const { manifest } = result;
    expect(manifest).toMatchObject({
      format: "videobook-har-export",
      version: 1,
      createdAt: "2026-10-24T12:00:00.000Z",
      apicity: { har: installedPackageVersion("@apicity/har"), captured: [installedPackageVersion("@apicity/har")] },
      filters: { since: null, failures: false, providers: null },
      files: 4,
      dateRange: { first: "2026-10-01T10:00:00.000Z", last: "2026-10-04T10:00:00.000Z" },
      outcomes: { ok: 2, provider_error: 2, local_error: 0, network_error: 0 },
      providers: [
        { provider: "fal", calls: 2, outcomes: { ok: 1, provider_error: 1, local_error: 0, network_error: 0 } },
        { provider: "kie", calls: 2, outcomes: { ok: 1, provider_error: 1, local_error: 0, network_error: 0 } },
      ],
    });
    expect(manifest.videobook).toMatch(/^\d+\.\d+\.\d+/u);
    expect(manifest.endpoints.map((item) => [item.provider, item.endpoint, item.calls])).toEqual([
      ["fal", LONG_ENDPOINT, 1], ["fal", "post.queue.submit", 1], ["kie", "post.api.v1.jobs.createTask", 2],
    ]);

    const exported = await tree(out);
    const source = await tree(dir);
    expect(JSON.parse(exported.get("manifest.json") ?? "{}")).toEqual(manifest);
    const rows = (exported.get("index.jsonl") ?? "").trim().split("\n").map((line) => JSON.parse(line) as { file: string; outcome: string });
    expect(rows.map((row) => row.outcome)).toEqual(["ok", "provider_error", "provider_error", "ok"]);
    for (const row of rows) expect(exported.get(row.file)).toBe(source.get(row.file));
    expect([...exported.keys()].sort()).toEqual(["index.jsonl", "manifest.json", ...rows.map((row) => row.file)].sort());
    const text = [...exported.values()].join("\n");
    expect(text).toContain("duration must be 5 or 10");
    for (const secret of ["sk-live-secret-123", "sk-input-secret"]) expect(text).not.toContain(secret);
  });

  it("honours since, failures and provider filters", async () => {
    const since = Date.parse("2026-10-02T00:00:00.000Z");
    const failures = await exportHarCaptures({ dir, out: join(root, "failures"), since, failures: true });
    expect(failures.status === "exported" && failures.manifest.endpoints.map((item) => item.endpoint))
      .toEqual(["post.queue.submit", "post.api.v1.jobs.createTask"]);
    expect(failures.status === "exported" && failures.manifest.filters)
      .toEqual({ since: "2026-10-02T00:00:00.000Z", failures: true, providers: null });

    const fal = await exportHarCaptures({ dir, out: join(root, "fal"), providers: ["fal"] });
    expect(fal.status === "exported" && fal.manifest.files).toBe(2);
    const kieFailures = await exportHarCaptures({ dir, out: join(root, "kie"), providers: ["kie"], failures: true });
    expect(kieFailures.status === "exported" && kieFailures.manifest.dateRange)
      .toEqual({ first: "2026-10-02T10:00:00.000Z", last: "2026-10-02T10:00:00.000Z" });
    expect(await exportHarCaptures({ dir, out: join(root, "none"), since: Date.parse("2026-11-01T00:00:00.000Z") }))
      .toEqual({ status: "empty", skipped: [] });
    expect(existsSync(join(root, "none"))).toBe(false);
  });

  it("refuses, naming the file, when scrubHar would change a capture", async () => {
    const [row] = await readHarIndex(dir);
    if (!row) throw new Error("No capture");
    const planted = join(dir, row.file);
    const har = JSON.parse(await readFile(planted, "utf8")) as Har;
    har.log.entries[0]?.request.headers.push({ name: "Authorization", value: "Bearer sk-planted-secret" });
    await writeFile(planted, JSON.stringify(har, null, 2));

    const out = join(root, "refused");
    expect(await exportHarCaptures({ dir, out })).toEqual({ status: "needs-scrub", files: [planted] });
    expect(existsSync(out)).toBe(false);
    expect(await exportHarCaptures({ dir, out: join(root, "archive.tar.gz") })).toEqual({ status: "needs-scrub", files: [planted] });
    expect(existsSync(join(root, "archive.tar.gz"))).toBe(false);
  });

  it("writes a .tar.gz that tar extracts to the same files, including long paths", async () => {
    const plain = join(root, "plain");
    const archive = join(root, "captures.tar.gz");
    const now = new Date("2026-10-24T12:00:00.000Z");
    expect((await exportHarCaptures({ dir, out: plain, now })).status).toBe("exported");
    const result = await exportHarCaptures({ dir, out: archive, now });
    expect(result).toMatchObject({ status: "exported", archive: true, out: archive });

    const extracted = join(root, "extracted");
    await mkdir(extracted);
    await exec("tar", ["-xzf", archive, "-C", extracted]);
    expect(await readdir(extracted)).toEqual(["captures"]);
    const files = await tree(join(extracted, "captures"));
    expect(files).toEqual(await tree(plain));
    expect([...files.keys()].some((file) => `captures/${file}`.length > 100)).toBe(true);
    const manifest = JSON.parse(files.get("manifest.json") ?? "{}") as HarExportManifest;
    expect(manifest.files).toBe(4);
  });

  it("refuses an existing output and an output inside the capture directory", async () => {
    const occupied = join(root, "occupied");
    await mkdir(occupied);
    await writeFile(join(occupied, "keep.txt"), "mine");
    expect(await exportHarCaptures({ dir, out: occupied })).toEqual({ status: "out-exists", out: occupied });
    expect(await readdir(occupied)).toEqual(["keep.txt"]);
    const archive = join(root, "taken.tgz");
    await writeFile(archive, "mine");
    expect(await exportHarCaptures({ dir, out: archive })).toEqual({ status: "out-exists", out: archive });
    expect(await readFile(archive, "utf8")).toBe("mine");
    expect(await exportHarCaptures({ dir, out: join(dir, "export") })).toEqual({ status: "out-inside-captures", out: join(dir, "export") });

    const empty = join(root, "empty");
    await mkdir(empty);
    expect((await exportHarCaptures({ dir, out: empty })).status).toBe("exported");
    expect((await readdir(empty)).sort()).toEqual(["fal", "index.jsonl", "kie", "manifest.json"]);
  });

  it("skips indexed captures that are missing and refuses index paths outside the directory", async () => {
    const rows = await readHarIndex(dir);
    const [first] = rows;
    if (!first) throw new Error("No capture");
    await rm(join(dir, first.file));
    const index = await readFile(join(dir, "index.jsonl"), "utf8");
    await writeFile(join(dir, "index.jsonl"), `${index}${JSON.stringify({ ...first, callId: "escape", file: "../outside.har" })}\n`);
    await writeFile(join(root, "outside.har"), JSON.stringify({ log: { version: "1.2", creator: { name: "x", version: "1" }, entries: [] } }));

    const result = await exportHarCaptures({ dir, out: join(root, "partial") });
    expect(result.status).toBe("exported");
    if (result.status !== "exported") return;
    expect(result.manifest.files).toBe(3);
    expect(result.skipped).toEqual([join(dir, first.file), "../outside.har"]);
    expect([...(await tree(join(root, "partial"))).keys()].some((file) => file.includes("outside"))).toBe(false);
  });
});
