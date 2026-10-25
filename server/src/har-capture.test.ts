import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createEngine, type Engine } from "videobook-engine";
import { findMatchingRow, type Har } from "@apicity/har";
import { appState, createFileApplicationState } from "./app-state.js";
import { withBookContext } from "./book-context.js";
import { createFal, createKie, createX, submitMediaJob, uploadFalFile, uploadAlibabaFile } from "./usage-providers.js";
import { flushHarCaptures, withHarCapture, withHarLocalFailure } from "./har-capture.js";
import { readHarSettings, writeHarSettings, harDirectory } from "./har-settings.js";
import { pruneHarCaptures } from "./har-retention.js";
import { setHarCaptureDef } from "./tools/set-har-capture.js";
import { configureLoggerForTests, resetLoggerForTests } from "./logger.js";
import { testBudget } from "./test-budget.js";

const exec = promisify(execFile);

describe("opt-in provider HAR diagnostics", () => {
  let root: string;
  let server: Server;
  let url: string;
  let home: string | undefined;
  let override: string | undefined;
  let stored: unknown;
  let reject = false;
  const engines: Engine[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-har-"));
    home = process.env.VIDEOBOOK_HOME;
    override = process.env.VIDEOBOOK_HAR_CAPTURE;
    process.env.VIDEOBOOK_HOME = root;
    delete process.env.VIDEOBOOK_HAR_CAPTURE;
    stored = await appState.get("harCapture");
    await appState.set("harCapture", null);
    reject = false;
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url?.includes("initiate")) res.end(JSON.stringify({ file_url: "https://media.test/file", upload_url: `${url}/bytes` }));
        else if (req.url?.includes("uploads")) res.end(JSON.stringify({ data: { upload_dir: "test", upload_host: `${url}/bytes`, oss_access_key_id: "secret", policy: "secret", signature: "secret", x_oss_object_acl: "private", x_oss_forbid_overwrite: "true" } }));
        else if (req.url === "/bytes") res.end("{}");
        else if (req.url?.includes("users/me")) res.end(JSON.stringify({ data: { id: "42", username: "test", name: "Test" } }));
        else if (req.url?.includes("/models") && !reject) res.end(JSON.stringify({ code: 200, data: [] }));
        else if (req.url?.startsWith("/claude/")) res.end(JSON.stringify({ type: "message", content: [] }));
        else if (req.url?.endsWith("/requests/expired/status")) {
          res.statusCode = 422;
          res.end(JSON.stringify({ detail: [{ loc: ["path", "request_id"], msg: "Invalid request id", type: "value_error" }] }));
        }
        else setTimeout(() => res.end(JSON.stringify(reject ? { code: 400, msg: "SDK rejects this 200 response" } : { code: 200, data: { taskId: "one", state: "success" } })), 5);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await flushHarCaptures();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const engine of engines.splice(0)) engine.close();
    await appState.set("harCapture", stored);
    if (home === undefined) delete process.env.VIDEOBOOK_HOME; else process.env.VIDEOBOOK_HOME = home;
    if (override === undefined) delete process.env.VIDEOBOOK_HAR_CAPTURE; else process.env.VIDEOBOOK_HAR_CAPTURE = override;
    resetLoggerForTests();
    await rm(root, { recursive: true, force: true });
  });

  async function captures(): Promise<Har[]> {
    await flushHarCaptures();
    const index = await readFile(join(harDirectory(), "index.jsonl"), "utf8").catch(() => "");
    return Promise.all(index.trim().split("\n").filter(Boolean).map(async (line) => {
      const row = JSON.parse(line) as { file: string };
      return JSON.parse(await readFile(join(harDirectory(), row.file), "utf8")) as Har;
    }));
  }

  it("writes nothing by default, applies settings to existing clients, and keeps SDK failures after HTTP 200", async () => {
    const provider = createKie({ apiKey: "test", baseURL: url });
    await provider.get.xai.v1.models();
    expect(await captures()).toEqual([]);
    await writeHarSettings({ mode: "failures" });
    await provider.get.xai.v1.models();
    expect(await captures()).toEqual([]);
    reject = true;
    await expect(provider.get.xai.v1.models()).rejects.toThrow();
    const files = await captures();
    expect(files).toHaveLength(1);
    expect(files[0]?.log._apicity).toMatchObject({ provider: "kie", endpoint: "xai.v1.models", outcome: "provider_error" });
    expect(files[0]?.log.entries[0]?.response.status).toBe(200);
    await writeHarSettings({ mode: "off" });
    await expect(provider.get.xai.v1.models()).rejects.toThrow();
    expect(await captures()).toHaveLength(1);
  });

  it("keeps the response when the KIE submission helper rejects a missing task id", async () => {
    await writeHarSettings({ mode: "failures" });
    reject = true;
    const provider = createKie({ apiKey: "test", baseURL: url });
    await expect(submitMediaJob(provider, { model: "qwen2/text-to-image", input: { prompt: "test" } })).rejects.toThrow();
    const files = await captures();
    expect(files).toHaveLength(1);
    expect(files[0]?.log._apicity).toMatchObject({ outcome: "provider_error" });
    expect(files[0]?.log.entries[0]?.response.status).toBe(200);
  });

  it("names nested KIE Veo and Suno SDK calls by the catalog dot paths apicity har report resolves", async () => {
    await writeHarSettings({ mode: "all" });
    const kie = createKie({ apiKey: "test", baseURL: url });
    await kie.veo.post.api.v1.veo.generate({ prompt: "test" });
    await kie.veo.get.api.v1.veo.recordInfo("one");
    await kie.suno.post.api.v1.generate({ prompt: "test", model: "V5", instrumental: false, customMode: false, callBackUrl: "https://callback.test" });
    await kie.suno.post.api.v1.generate.sounds({ prompt: "test", model: "V5" });
    await kie.suno.get.api.v1.generate.recordInfo("one");
    await kie.claude.post.v1.messages({ model: "claude-haiku-4-5", messages: [] });
    await kie.post.api.v1.jobs.createTask({ model: "qwen2/text-to-image", input: { prompt: "test" } });
    await kie.get.api.v1.jobs.recordInfo("one");
    await kie.get.xai.v1.models();
    const catalog = [
      ["POST", "api.v1.veo.generate", "/api/v1/veo/generate"],
      ["GET", "api.v1.veo.recordInfo", "/api/v1/veo/record-info?taskId={taskId}"],
      ["POST", "api.v1.generate", "/api/v1/generate"],
      ["POST", "api.v1.generate.sounds", "/api/v1/generate/sounds"],
      ["GET", "api.v1.generate.recordInfo", "/api/v1/generate/record-info?taskId={taskId}"],
      ["POST", "claude.v1.messages", "/claude/v1/messages"],
      ["POST", "api.v1.jobs.createTask", "/api/v1/jobs/createTask"],
      ["GET", "api.v1.jobs.recordInfo", "/api/v1/jobs/recordInfo?taskId={taskId}"],
      ["GET", "xai.v1.models", "/xai/v1/models"],
    ].map(([method, dotPath, path]) => ({ provider: "kie", method, dotPath, fullUrl: `https://api.kie.ai${path}` }));
    const files = await captures();
    expect(files.map((file) => file.log._apicity?.endpoint).sort()).toEqual(catalog.map((row) => row.dotPath).sort());
    for (const file of files) {
      const candidates = catalog.filter((row) => row.provider === file.log._apicity?.provider && row.dotPath === file.log._apicity?.endpoint);
      expect(candidates).toHaveLength(1);
      expect(findMatchingRow(file.log.entries[0], candidates, { provider: "kie" })).toBe(candidates[0]);
    }
  });

  it("names fal queue submit, status and result captures by the catalog rows apicity har report resolves", async () => {
    await writeHarSettings({ mode: "all" });
    const fal = createFal({ apiKey: "test", queueBaseURL: url });
    const endpoint_id = "fal-ai/flux/dev";
    await fal.v1.queue.submit({ endpoint_id, input: { prompt: "test" } });
    await fal.v1.queue.status({ endpoint_id, request_id: "one" });
    await fal.v1.queue.result({ endpoint_id, request_id: "one" });
    await expect(fal.v1.queue.status({ endpoint_id, request_id: "expired" })).rejects.toThrow();
    const catalog = [
      ["POST", "v1.queue.submit", "https://queue.fal.run/{endpoint_id}{query}"],
      ["GET", "v1.queue.status", "https://queue.fal.run/{endpoint_id}/requests/{request_id}/status"],
      ["GET", "v1.queue.result", "https://queue.fal.run/{endpoint_id}/requests/{request_id}"],
    ].map(([method, dotPath, fullUrl]) => ({ provider: "fal", method, dotPath, fullUrl }));
    const files = await captures();
    expect(files.map((file) => [file.log._apicity?.endpoint, file.log._apicity?.outcome]).sort()).toEqual([
      ["v1.queue.result", "ok"],
      ["v1.queue.status", "ok"],
      ["v1.queue.status", "provider_error"],
      ["v1.queue.submit", "ok"],
    ]);
    for (const file of files) {
      const candidates = catalog.filter((row) => row.provider === file.log._apicity?.provider && row.dotPath === file.log._apicity?.endpoint);
      expect(candidates).toHaveLength(1);
      const resolved = findMatchingRow(file.log.entries[0], candidates, { provider: "fal" }) ?? (file.log.entries.length === 1 ? candidates[0] : null);
      expect(resolved).toBe(candidates[0]);
    }
  });

  it("isolates two concurrent books through shared KIE and previously bypassing X clients", async () => {
    await writeHarSettings({ mode: "all" });
    const kie = createKie({ apiKey: "test", baseURL: url });
    const x = createX({ accessToken: "test", baseURL: url });
    await Promise.all(["first", "second"].map(async (name) => {
      const engine = createEngine({ rootDir: join(root, name), initialBookName: name });
      engines.push(engine);
      await engine.ready;
      return withBookContext({ bookId: engine.book.get().bookId, engine, artifactId: name, attemptId: name, runId: `run-${name}`, model: "kie:test" }, async () => {
        await Promise.all([kie.get.api.v1.jobs.recordInfo(name), x.get.v2.users.me()]);
      });
    }));
    const files = await captures();
    expect(files).toHaveLength(4);
    for (const name of ["first", "second"]) {
      const matched = files.filter((file) => file.log._apicity?.context?.attemptId === name);
      expect(matched).toHaveLength(2);
      expect(new Set(matched.map((file) => file.log._apicity?.provider))).toEqual(new Set(["kie", "x"]));
      for (const file of matched) expect(file.log._apicity?.context).toMatchObject({ artifactId: name, runId: `run-${name}`, model: "kie:test" });
    }
    expect(files.find((file) => file.log._apicity?.context?.attemptId === "first")?.log._apicity?.context?.bookId)
      .not.toBe(files.find((file) => file.log._apicity?.context?.attemptId === "second")?.log._apicity?.context?.bookId);
  });

  it("records local validation failures with input and isolates write failures from results", async () => {
    await writeHarSettings({ mode: "failures" });
    await expect(withHarCapture({ provider: "kie", endpoint: "api.v1.jobs.createTask", input: { prompt: "keep", api_key: "secret", otp: "secret" } }, () => z.number().parse("invalid"))).rejects.toThrow();
    const files = await captures();
    expect(files[0]?.log._apicity).toMatchObject({ outcome: "local_error", input: { prompt: "keep", api_key: "***", otp: "***" } });
    expect(files[0]?.log.entries[0]?._apicity?.kind).toBe("local");
    const form = new FormData();
    form.append("client_secret", "form-secret");
    form.append("file", new Blob(["media"]));
    await expect(withHarCapture({ provider: "dropbox", endpoint: "local", input: form }, () => { throw new Error("rejected"); })).rejects.toThrow("rejected");
    const formCapture = (await captures()).find((file) => file.log._apicity?.provider === "dropbox");
    expect(formCapture?.log._apicity?.input).toMatchObject({ client_secret: "***", file: { _file: { size: 5 } } });
    await rm(harDirectory(), { recursive: true });
    await writeFile(harDirectory(), "not a directory");
    const warnings: unknown[] = [];
    configureLoggerForTests({ level: "warn", sink: { warn: (...args) => warnings.push(args), error: () => {}, info: () => {}, debug: () => {} } });
    await writeHarSettings({ mode: "all" });
    expect(await withHarCapture({ provider: "kie", endpoint: "local", input: {} }, () => 42)).toBe(42);
    await flushHarCaptures();
    expect(JSON.stringify(warnings)).toContain("har-capture-failed");
    const invalid = Object.defineProperty({}, "input", { enumerable: true, get() { throw new Error("invalid metadata"); } });
    expect(await withHarCapture({ provider: "kie", endpoint: "local", input: invalid }, () => 7)).toBe(7);
  });

  it("omits successful local wrappers and records nested failures only once", async () => {
    await writeHarSettings({ mode: "all" });
    const meta = { provider: "kie", endpoint: "api.v1.jobs.createTask", input: {} };
    expect(await withHarLocalFailure(meta, async () => 42)).toBe(42);
    expect(await captures()).toEqual([]);
    await expect(withHarLocalFailure(meta, () => withHarLocalFailure(meta, async () => {
      throw new Error("local refusal");
    }))).rejects.toThrow("local refusal");
    expect(await captures()).toHaveLength(1);
    reject = true;
    const provider = createKie({ apiKey: "test", baseURL: url });
    await expect(withHarLocalFailure(meta, async () => {
      try { await provider.get.xai.v1.models(); }
      catch (cause) { throw new Error("wrapped provider refusal", { cause }); }
    })).rejects.toThrow("wrapped provider refusal");
    const files = await captures();
    expect(files).toHaveLength(2);
    expect(files.filter(file => file.log._apicity?.outcome === "provider_error")).toHaveLength(1);
  });

  it("captures auxiliary fal and Alibaba storage requests using the SDK injected fetch", async () => {
    await writeHarSettings({ mode: "all" });
    await uploadFalFile({ apiKey: "test", baseURL: url, restBaseURL: url }, { data: new Uint8Array([1, 2]), filename: "image.png", contentType: "image/png" });
    await uploadAlibabaFile({ apiKey: "test", baseURL: url }, { data: new Uint8Array([1, 2]), filename: "image.png", contentType: "image/png", model: "wan" });
    const files = await captures();
    expect(files).toHaveLength(2);
    expect(files.map(file => file.log._apicity?.endpoint).sort()).toEqual(["api.v1.uploads", "storage.upload.initiate"]);
    for (const file of files) {
      expect(file.log.entries).toHaveLength(2);
      expect(file.log._apicity?.input).toMatchObject({ data: { _apicity_placeholder: { bytes: 2 } } });
    }
    expect(JSON.stringify(files)).not.toContain('"secret"');
  });

  it("prunes by age and total size and rewrites the index; off preserves files", async () => {
    const dir = harDirectory();
    await mkdir(dir);
    for (const name of ["old", "middle", "new"]) await writeFile(join(dir, `${name}.har`), "x".repeat(100));
    await utimes(join(dir, "old.har"), new Date(0), new Date(0));
    await utimes(join(dir, "middle.har"), new Date(Date.now() - 1000), new Date(Date.now() - 1000));
    await writeFile(join(dir, "index.jsonl"), ["old", "middle", "new"].map((name) => JSON.stringify({ file: `${name}.har` }) + "\n").join(""));
    const limits = { mode: "all" as const, maxAgeDays: 30, maxTotalMB: 160 / (1024 * 1024) };
    await pruneHarCaptures(dir, { ...limits, mode: "off" });
    expect(await readFile(join(dir, "old.har"), "utf8")).toHaveLength(100);
    await pruneHarCaptures(dir, limits);
    expect(await readFile(join(dir, "index.jsonl"), "utf8")).toBe(JSON.stringify({ file: "new.har" }) + "\n");
    await expect(readFile(join(dir, "old.har"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, "middle.har"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips MCP settings, retention limits and environment overrides", async () => {
    const store = createFileApplicationState(join(root, "settings.json"));
    const tool = setHarCaptureDef(store);
    await tool.handler({ mode: "all", maxAgeDays: 7, maxTotalMB: 8 });
    const result = await tool.handler({});
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ mode: "all", maxAgeDays: 7, maxTotalMB: 8 });
    process.env.VIDEOBOOK_HAR_CAPTURE = "off";
    expect(await readHarSettings(store)).toMatchObject({ mode: "off" });
    await tool.handler({ maxAgeDays: 9 });
    delete process.env.VIDEOBOOK_HAR_CAPTURE;
    expect(await readHarSettings(store)).toMatchObject({ mode: "all", maxAgeDays: 9 });
    expect((await tool.handler({ mode: "wrong" })).isError).toBe(true);
  });

  it("round-trips CLI settings and reports the doctor row without creating captures", async () => {
    const env = { ...process.env, VIDEOBOOK_HOME: root, VIDEOBOOK_APP_STATE_PATH: join(root, "app-state.json") };
    const cli = (...args: string[]) => exec(process.execPath, ["--import", "tsx", "server/src/cli/entry.ts", ...args], { env, timeout: testBudget(60_000) });
    await cli("config", "set", "har_capture", "failures");
    const config = await cli("config", "get", "har_capture", "--json");
    expect(JSON.parse(config.stdout).harCapture.mode).toBe("failures");
    const doctor = await cli("doctor", "--json").catch((error: unknown) => error as { stdout: string });
    expect(doctor.stdout).toContain('"har-capture"');
    expect(doctor.stdout).toContain("writable:");
    expect(await captures()).toEqual([]);
  }, testBudget(90_000));
});
