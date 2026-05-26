import "dotenv/config";
import express from "express";
import cors from "cors";
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { queue, reconcileQueueOnStartup } from "./queue.js";
import { fs, PROJECTS_DIR } from "./fs.js";
import { registerAllJobHandlers } from "./jobs/index.js";
import { initImageModels } from "./image-models.js";
import { loadAndArmAll, stopScheduler } from "./scheduled-posts.js";
import { uploadLocalStream } from "./local-upload.js";

// Rename a legacy ~/.clipfirst/ user-config dir to ~/.videocity/ if it still
// exists. Idempotent — no-op once .videocity/ is in place. If both exist
// (paranoid), move missing files over and drop the legacy dir.
async function migrateLegacyUserDir(): Promise<void> {
  const legacy = join(homedir(), ".clipfirst");
  const current = join(homedir(), ".videocity");
  let legacyExists = false;
  try {
    await fsp.access(legacy);
    legacyExists = true;
  } catch {
    // path doesn't exist
  }
  if (!legacyExists) return;
  let currentExists = false;
  try {
    await fsp.access(current);
    currentExists = true;
  } catch {
    // path doesn't exist
  }
  if (!currentExists) {
    await fsp.rename(legacy, current);
    console.log("[startup] migrated ~/.clipfirst -> ~/.videocity");
    return;
  }
  const entries = await fsp.readdir(legacy);
  for (const entry of entries) {
    const src = join(legacy, entry);
    const dst = join(current, entry);
    try {
      await fsp.access(dst);
      continue;
    } catch {
    // path doesn't exist
  }
    await fsp.rename(src, dst);
  }
  await fsp.rm(legacy, { recursive: true, force: true });
  console.log("[startup] merged ~/.clipfirst into ~/.videocity");
}

const ASSET_REAPER_INTERVAL_MS = 30_000;
const reaperHandles: { stop: () => void }[] = [];

const app = express();
app.use(cors());
app.use("/files", express.static(PROJECTS_DIR, { dotfiles: "allow" }));

app.post("/api/upload/:projectSlug", async (req, res) => {
  const filename = typeof req.query.filename === "string" ? req.query.filename : "";
  if (!filename) {
    res.status(400).json({ error: "Missing filename" });
    return;
  }

  const result = await uploadLocalStream(fs, {
    projectSlug: req.params.projectSlug,
    filename,
    stream: req,
  });

  if (!result.ok) {
    res.status(result.statusCode).json({ error: result.message });
    return;
  }

  res.json(result.value);
});

app.use(express.json({ limit: "500mb" }));

app.get("/api/manifest/:projectSlug/:assetId", async (req, res) => {
  const { projectSlug, assetId } = req.params;
  const result = await fs.getManifest(assetId, projectSlug, {
    includeDotfiles: true,
  });
  if (result.ok) {
    res.json(result.value);
  } else {
    const status = result.error.code === "NOT_FOUND" ? 404 : 400;
    res.status(status).json({ error: result.error.message });
  }
});

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST." },
      id: null,
    }),
  );
});

async function start(): Promise<void> {
  await migrateLegacyUserDir();
  registerAllJobHandlers(fs);
  await initImageModels();
  await queue.start();
  for (const project of await fs.listProjects()) {
    const check = await fs.checkSchemaVersion(project.slug);
    if (!check.ok) {
      console.error(
        `[startup] refusing to open ${project.slug}: ${check.reason}`,
      );
      console.error(
        "[startup] upgrade videocity (or roll back the project) before continuing.",
      );
      process.exit(1);
    }
    const aborted = await fs.recoverIncompleteOperations(project.slug);
    if (aborted > 0) {
      console.log(
        `[startup] aborted ${aborted} orphan operation(s) in ${project.slug}`,
      );
    }
    // Backfill the assets table from disk + tables. Replaces the old
    // sidecar-cleanup helpers for completing/queued/lock-race rows once the
    // assets table is the projected source of truth.
    const recovered = await fs.recoverAssetsTable(project.slug);
    if (recovered.ok) {
      console.log(
        `[startup] recovered ${recovered.value.recovered} asset row(s) in ${project.slug}`,
      );
    }
    // Start the deadline-driven reaper for this project.
    const reaper = await fs.startAssetReaper(project.slug, {
      intervalMs: ASSET_REAPER_INTERVAL_MS,
    });
    if (reaper) reaperHandles.push(reaper);
  }
  await reconcileQueueOnStartup();
  await loadAndArmAll();
  const PORT = process.env.PORT ?? 3001;
  app.listen(PORT, () => {
    console.log(`MCP server listening on http://127.0.0.1:${PORT}/mcp`);
  });
}

process.on("SIGINT", async () => {
  for (const h of reaperHandles) h.stop();
  stopScheduler();
  await queue.stop();
  fs.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  for (const h of reaperHandles) h.stop();
  stopScheduler();
  await queue.stop();
  fs.close();
  process.exit(0);
});

start();
