import "./load-env.js";
import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { queue, reconcileQueueOnStartup } from "./queue.js";
import { localArchiveDir } from "./archive-store.js";
import { fs } from "./fs.js";
import { registerAllJobHandlers } from "./jobs/index.js";
import { loadAndArmAll, stopScheduler } from "./scheduled-posts.js";
import { uploadLocalStream } from "./local-upload.js";

const ASSET_REAPER_INTERVAL_MS = 30_000;
const reaperHandles: { stop: () => void }[] = [];

const app = express();
app.use(cors());
app.use("/archive-files", express.static(localArchiveDir(), { dotfiles: "allow" }));

app.get(/^\/files\/([^/]+)\/([^/]+)\/(.+)$/, async (req, res) => {
  const projectSlug = String(req.params[0]);
  const artifactSlug = String(req.params[1]);
  const filename = String(req.params[2]);
  const result = await fs.files.read(artifactSlug, filename, projectSlug);
  if (!result.ok) {
    res
      .status(result.error.code === "NOT_FOUND" ? 404 : 400)
      .json({ error: result.error.message });
    return;
  }
  res.type(filename).send(result.value);
});

app.post("/api/upload/:projectSlug", async (req, res) => {
  const filename = typeof req.query.filename === "string" ? req.query.filename : "";
  if (!filename) {
    res.status(400).json({ error: "Missing filename" });
    return;
  }

  const targetAssetId = typeof req.query.targetAssetId === "string" ? req.query.targetAssetId : undefined;

  const result = await uploadLocalStream(fs, {
    projectSlug: req.params.projectSlug,
    filename,
    stream: req,
    targetAssetId,
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
  const result = await fs.files.manifest(assetId, projectSlug, {
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
  await fs.ready;
  registerAllJobHandlers(fs);
  await queue.start();
  const check = fs.jobs.checkSchema();
  if (!check.ok) {
    console.error(`[startup] refusing to open catalog: ${check.reason}`);
    console.error(
      "[startup] upgrade videobook (or roll back the catalog) before continuing.",
    );
    process.exit(1);
  }
  for (const project of fs.projects.list()) {
    const recovered = fs.jobs.recoverAll(project.projectId);
    if (recovered.ok) {
      console.log(
        `[startup] recovered ${recovered.value.recovered} artifact row(s) in ${project.slug}`,
      );
    }
    const reaper = fs.jobs.startReaper(project.projectId, {
      intervalMs: ASSET_REAPER_INTERVAL_MS,
    });
    reaperHandles.push(reaper);
  }
  await reconcileQueueOnStartup();
  await loadAndArmAll();
  const PORT = process.env.PORT ?? 3001;
  app.listen(PORT, () => {
    console.log(`MCP server listening on http://127.0.0.1:${PORT}/mcp`);
  });
}

async function shutdown(): Promise<void> {
  let exitCode = 0;
  try {
    for (const h of reaperHandles) h.stop();
    stopScheduler();
    await queue.stop();
    fs.close();
  } catch (error) {
    console.error("[shutdown] cleanup failed:", error);
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((error) => {
  console.error("[startup] fatal:", error);
  process.exit(1);
});
