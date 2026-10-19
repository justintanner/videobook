import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { SCHEMA_VERSION } from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { localArchiveDir } from "./archive-store.js";
import { bookManager, scopedEngine } from "./engine.js";
import { parseHttpByteRange } from "./http-byte-range.js";
import { restrictHttpAccess, restrictMediaContent } from "./http-access.js";
import { uploadLocalStream } from "./local-upload.js";
import { queue } from "./queue.js";
import { searchReferenceStore } from "./search-reference-store.js";
import { SERVER_VERSION, createHttpHandler } from "./server.js";
import { VoiceSessions } from "./voice-session.js";
import { voiceRouter } from "./voice-http.js";

export interface VideobookApp {
  app: Express;
  mcpHandler: McpHttpHandler;
  voiceSessions: VoiceSessions;
}

const enginePackage = createRequire(import.meta.url)("videobook-engine/package.json") as {
  version: string;
};
const SEARCH_REFERENCE_LIMIT_BYTES = 500 * 1024 * 1024;

function limitUploadBytes(maxBytes: number): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        callback(new Error("Search reference exceeds the 500 MB limit"));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function engineForBook(
  bookId: string,
): Promise<ReturnType<typeof bookManager.get>> {
  return bookManager.ensure(bookId);
}

function sendHealth(_req: Request, res: Response): void {
  res.json({
    ok: true,
    service: "videobook",
    version: SERVER_VERSION,
    engineVersion: enginePackage.version,
    schemaVersion: SCHEMA_VERSION,
  });
}

async function sendArtifactFile(req: Request, res: Response): Promise<void> {
  const bookId = String(req.params[0]);
  const artifactId = String(req.params[1]);
  const filename = String(req.params[2]);
  const book = await engineForBook(bookId);
  if (!book.ok) {
    res.status(404).json({ error: book.error.message });
    return;
  }
  const result = await book.value.engine.files.read(artifactId, filename);
  if (!result.ok) {
    res.status(result.error.code === "NOT_FOUND" ? 404 : 400).json({ error: result.error.message });
    return;
  }
  res.type(filename);
  res.setHeader("Accept-Ranges", "bytes");
  const etag = `"${createHash("sha256").update(result.value).digest("hex")}"`;
  res.setHeader("ETag", etag);
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  const rangeHeader = req.headers.range;
  const ifRange = req.get("If-Range");
  if (req.method === "HEAD" || !rangeHeader || (ifRange !== undefined && ifRange !== etag)) {
    res.send(result.value);
    return;
  }
  const range = parseHttpByteRange(rangeHeader, result.value.byteLength);
  if (!range.ok) {
    res.setHeader("Content-Range", `bytes */${result.value.byteLength}`);
    res.sendStatus(416);
    return;
  }
  res.status(206);
  res.setHeader(
    "Content-Range",
    `bytes ${range.start}-${range.end}/${result.value.byteLength}`,
  );
  res.send(result.value.subarray(range.start, range.end + 1));
}

async function receiveUpload(req: Request, res: Response): Promise<void> {
  const filename = typeof req.query.filename === "string" ? req.query.filename : "";
  if (!filename) {
    res.status(400).json({ error: "Missing filename" });
    return;
  }
  const book = await engineForBook(String(req.params.bookId));
  if (!book.ok) {
    res.status(404).json({ error: book.error.message });
    return;
  }
  const targetAssetId = typeof req.query.targetAssetId === "string" ? req.query.targetAssetId : undefined;
  const result = await uploadLocalStream(book.value.engine, {
    bookId: book.value.bookId,
    filename,
    stream: req,
    targetAssetId,
  });
  if (!result.ok) {
    res.status(result.statusCode).json({ error: result.message });
    return;
  }
  res.json(result.value);
}

async function receiveSearchReference(req: Request, res: Response): Promise<void> {
  const filename = typeof req.query.filename === "string" ? req.query.filename : "";
  const bookId = typeof req.query.bookId === "string" ? req.query.bookId : "";
  const kind = req.query.kind === "image" || req.query.kind === "video"
    ? req.query.kind
    : null;
  if (!filename || !bookId || !kind) {
    res.status(400).json({ error: "filename, bookId, and kind are required" });
    return;
  }
  const book = await engineForBook(bookId);
  if (!book.ok) {
    res.status(404).json({ error: book.error.message });
    return;
  }
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (declaredLength > SEARCH_REFERENCE_LIMIT_BYTES) {
    res.status(413).json({ error: "Search reference exceeds the 500 MB limit" });
    return;
  }
  const uploadRoot = await mkdtemp(join(tmpdir(), "videobook-search-upload-"));
  const suffix = extname(filename).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const uploadPath = join(uploadRoot, `reference${suffix}`);
  try {
    await pipeline(
      req,
      limitUploadBytes(SEARCH_REFERENCE_LIMIT_BYTES),
      createWriteStream(uploadPath, { flags: "wx" }),
    );
    const result = await queue.enqueueAndWait(
      `prepare-search-reference-${uuidv7()}`,
      {
        type: "prepare_search_reference",
        bookId,
        mediaKind: kind,
        name: filename,
        uploadPath,
        cleanupRoot: uploadRoot,
      },
      15 * 60_000,
    );
    res.json(result);
  } catch (cause) {
    await rm(uploadRoot, { recursive: true, force: true });
    const message = cause instanceof Error ? cause.message : String(cause);
    res.status(message.includes("500 MB limit") ? 413 : 400).json({
      error: message,
    });
  }
}

function sendSearchReferencePreview(req: Request, res: Response): void {
  try {
    const preview = searchReferenceStore.get(String(req.params.referenceId)).preview;
    if (!preview) {
      res.status(404).json({ error: "Search reference preview is unavailable" });
      return;
    }
    res.set("Cache-Control", "no-store").type("png").send(preview);
  } catch (cause) {
    res.status(404).json({ error: cause instanceof Error ? cause.message : String(cause) });
  }
}

function releaseSearchReference(req: Request, res: Response): void {
  res.json({
    released: searchReferenceStore.release(String(req.params.referenceId)),
  });
}

async function sendArtifactManifest(req: Request, res: Response): Promise<void> {
  const book = await engineForBook(String(req.params.bookId));
  if (!book.ok) {
    res.status(404).json({ error: book.error.message });
    return;
  }
  const result = await book.value.engine.files.manifest(String(req.params.artifactId), {
    includeDotfiles: true,
  });
  if (!result.ok) {
    res.status(result.error.code === "NOT_FOUND" ? 404 : 400).json({ error: result.error.message });
    return;
  }
  res.json(result.value);
}

function registerAccessPolicy(app: Express): void {
  app.use(restrictHttpAccess);
  app.use(cors({ origin: true }));
  app.use(["/files", "/archive-files"], restrictMediaContent);
}

function registerMediaRoutes(app: Express): void {
  app.use("/archive-files", express.static(localArchiveDir(), { dotfiles: "allow" }));
  app.get("/healthz", sendHealth);
  app.get(/^\/files\/([^/]+)\/([^/]+)\/(.+)$/, sendArtifactFile);
}

function registerApiRoutes(app: Express, voiceSessions: VoiceSessions): void {
  app.post("/api/books/:bookId/upload", receiveUpload);
  app.post("/api/search-references", receiveSearchReference);
  app.get("/api/search-references/:referenceId/preview", sendSearchReferencePreview);
  app.delete("/api/search-references/:referenceId", releaseSearchReference);
  app.use("/api/voice", voiceRouter(voiceSessions));
  app.use(express.json({ limit: "500mb" }));
  app.get("/api/books/:bookId/artifacts/:artifactId/manifest", sendArtifactManifest);
}

function registerMcpRoute(app: Express, mcpHandler: McpHttpHandler): void {
  const handleMcpRequest = toNodeHandler(mcpHandler);
  app.all("/mcp", (req, res) => {
    void handleMcpRequest(req, res, req.body);
  });
}

export function createApp(): VideobookApp {
  const app = express();
  const voiceSessions = new VoiceSessions(bookManager);
  const mcpHandler = createHttpHandler(scopedEngine, bookManager);
  registerAccessPolicy(app);
  registerMediaRoutes(app);
  registerApiRoutes(app, voiceSessions);
  registerMcpRoute(app, mcpHandler);
  return { app, mcpHandler, voiceSessions };
}
