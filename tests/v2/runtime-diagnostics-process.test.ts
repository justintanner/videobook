import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ensureAceServer, stopAceServer } from "../../server/src/acestep/process.js";
import { configureLoggerForTests, resetLoggerForTests } from "../../server/src/logger.js";

it("drains a real provider subprocess without logging its private stdout or stderr", async () => {
  const root = await mkdtemp(join(tmpdir(), "videobook-private-provider-"));
  const keys = ["VIDEOBOOK_ACESTEP_BASE_URL", "VIDEOBOOK_ACESTEP_PORT", "VIDEOBOOK_ACESTEP_SERVER_PATH", "VIDEOBOOK_ACESTEP_MODELS_DIR", "VIDEOBOOK_ACESTEP_MODEL"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const lines: string[] = [];
  const collect = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  configureLoggerForTests({ level: "debug", sink: { error: collect, warn: collect, info: collect, debug: collect } });
  try {
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    const executable = join(root, "ace-server");
    await writeFile(executable, `#!/usr/bin/env node
const http = require('node:http');
const { once } = require('node:events');
async function run() {
  const text = 'private-provider-prompt token=plaincredential\\n'.repeat(40000);
  for (const stream of [process.stdout, process.stderr]) {
    if (!stream.write(text)) await once(stream, 'drain');
  }
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: 'ok' }));
  }).listen(port, '127.0.0.1');
}
run();
`, { mode: 0o755 });
    for (const name of ["fixture.gguf", "Qwen3-Embedding-0.6B-Q8_0.gguf", "vae-BF16.gguf"]) {
      await writeFile(join(root, name), "process-fixture-only");
    }
    delete process.env.VIDEOBOOK_ACESTEP_BASE_URL;
    process.env.VIDEOBOOK_ACESTEP_PORT = String(address.port);
    process.env.VIDEOBOOK_ACESTEP_SERVER_PATH = executable;
    process.env.VIDEOBOOK_ACESTEP_MODELS_DIR = root;
    process.env.VIDEOBOOK_ACESTEP_MODEL = "fixture.gguf";
    expect(await ensureAceServer({ signal: AbortSignal.timeout(10_000) })).toMatchObject({ owned: true });
    await stopAceServer();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ace-server-exited");
    expect(lines[0]).toContain("SIGTERM");
    expect(lines.join("\n")).not.toContain("private-provider-prompt");
    expect(lines.join("\n")).not.toContain("plaincredential");
    expect(lines.join("\n")).not.toContain(root);
  } finally {
    await stopAceServer();
    resetLoggerForTests();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 20_000);
