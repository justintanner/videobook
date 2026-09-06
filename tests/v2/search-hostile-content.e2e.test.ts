import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { chromium } from "playwright";
import type { Browser, Page, Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Engine, IndexManifest, Result } from "videobook-engine";
import { BookManager } from "../../server/src/book-manager.js";
import {
  availablePort,
  record,
  requestBody,
  resultValue,
  startProcess,
  stopProcess,
  toolCalls,
  waitForHttp,
  type StartedProcess,
} from "./e2e-harness.js";

/**
 * PRD section 13: search excerpts and explanations are user content. These
 * fixtures are real indexed data (book name, artifact label, indexed text) that
 * reach the browser through the actual MCP server; the explanation and error
 * variants are injected at the HTTP boundary because the engine writes those
 * strings itself. Every surface must render the literal text and execute none
 * of it.
 */
const BOOK = '<img src=x onerror="window.__xssBook=1"><i>hostile book</i>';
const LABEL =
  '<img src=x onerror="window.__xssLabel=1"><b>hostile label</b> hostile-label-marker';
const EXCERPT =
  '<script>window.__xssExcerpt=1</script><img src=x onerror="window.__xssExcerpt=2"> hostile-excerpt-marker <a href="javascript:window.__xssExcerpt=3">link</a>';
const EXPLANATION =
  '"><svg onload="window.__xssExplanation=1"><img src=x onerror="window.__xssExplanation=2"> hostile explanation';
const ERROR_TEXT =
  '<img src=x onerror="window.__xssError=1"><script>window.__xssError=2</script> hostile error text';
const MCP_ROUNDTRIP_MS = 15_000;

const manifest: IndexManifest = {
  manifestId: "hostile-lexical-v1",
  provider: "fixture",
  modelId: "fixture",
  modelRevision: "1",
  license: "test",
  embeddingSpace: "hostile-lexical-space",
  dimensions: 3,
  modalities: ["visual", "metadata"],
  supportedLanguages: ["en"],
  preprocessingVersion: "1",
  extractorVersion: "1",
  createdAt: 1,
};

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYPgPAAEDAQBdlO9aAAAAAElFTkSuQmCC",
  "base64",
);

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function seedHostileBook(engine: Engine): Promise<string> {
  const artifact = value(await engine.artifacts.create("image", LABEL));
  value(await engine.files.write(artifact.artifactId, "original.png", png));
  const source = value(await engine.files.manifest(artifact.artifactId))
    .files[0]!;
  value(engine.temporalSearch.manifests.register(manifest));
  value(
    engine.temporalSearch.commitBatch({
      artifactId: artifact.artifactId,
      objectHash: source.objectHash,
      manifestId: manifest.manifestId,
      generation: "hostile-generation",
      phase: "lexical",
      maxUnits: 1,
      observations: [
        {
          artifactId: artifact.artifactId,
          objectHash: source.objectHash,
          sourcePath: source.name,
          kind: "frame",
          segmentationVersion: "1",
          texts: [{ kind: "description", language: "en", text: EXCERPT }],
          embeddings: [
            {
              modality: "visual",
              embeddingSpace: manifest.embeddingSpace,
              vector: [1, 0, 0],
              sourceHash: source.objectHash,
            },
          ],
          fingerprints: [],
        },
      ],
      coveredRanges: [],
      totalUnits: 1,
      complete: true,
    }),
  );
  value(
    engine.temporalSearch.activate(manifest.manifestId, "hostile-generation"),
  );
  value(await engine.temporalSearch.prepare());
  return artifact.artifactId;
}

type Envelope = Record<string, unknown>;

/** Rewrites every tools/call result in a real MCP HTTP response (JSON or SSE body). */
async function rewriteToolResults(
  route: Route,
  rewrite: (result: Envelope) => Envelope,
): Promise<void> {
  const response = await route.fetch();
  const contentType = response.headers()["content-type"] ?? "";
  const text = await response.text();
  const rewriteEnvelope = (entry: unknown): unknown => {
    const envelope = record(entry);
    const result = record(envelope?.result);
    return envelope && result
      ? { ...envelope, result: rewrite(result) }
      : entry;
  };
  let body: string;
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(text) as unknown;
    body = JSON.stringify(
      Array.isArray(parsed)
        ? parsed.map(rewriteEnvelope)
        : rewriteEnvelope(parsed),
    );
  } else if (contentType.includes("text/event-stream")) {
    body = text
      .split("\n")
      .map((line) =>
        line.startsWith("data:")
          ? `data: ${JSON.stringify(rewriteEnvelope(JSON.parse(line.slice(5))))}`
          : line,
      )
      .join("\n");
  } else {
    throw new Error(`Unexpected MCP response content type: ${contentType}`);
  }
  await route.fulfill({
    status: response.status(),
    headers: response.headers(),
    body,
  });
}

function toolResultText(result: Envelope): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const item = content.map(record).find((entry) => entry?.type === "text");
  return typeof item?.text === "string" ? item.text : "";
}

describe("hostile search content across browser surfaces", () => {
  let rootDir = "";
  let mcpProcess: StartedProcess | undefined;
  let viteProcess: StartedProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let appUrl = "";
  let bookId = "";
  let artifactId = "";
  let interception: "none" | "explanation" | "error" = "none";
  const pageErrors: string[] = [];

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-hostile-search-e2e-"));
    const libraryDir = join(rootDir, "books");
    const books = new BookManager({ libraryDir });
    await books.ready();
    bookId = value(await books.create(BOOK)).bookId;
    artifactId = await seedHostileBook(value(books.get(bookId)).engine);
    await books.close();

    const mcpPort = await availablePort();
    const vitePort = await availablePort();
    const mcpOrigin = `http://127.0.0.1:${mcpPort}`;
    appUrl = `http://127.0.0.1:${vitePort}`;
    mcpProcess = startProcess(["--import", "tsx", "server/src/index.ts"], {
      ...process.env,
      PORT: String(mcpPort),
      VIDEOBOOK_APP_STATE_PATH: join(rootDir, "runtime", "app-state.json"),
      VIDEOBOOK_LIBRARY_DIR: libraryDir,
      VIDEOBOOK_MODEL_DOWNLOAD: "disabled",
      VIDEOBOOK_MODEL_CACHE_DIR: join(rootDir, "missing-models"),
    });
    await waitForHttp(`${mcpOrigin}/healthz`, mcpProcess, 200);
    const client = new Client(
      { name: "videobook-hostile-search-e2e", version: "1.0.0" },
      {
        capabilities: {},
        supportedProtocolVersions: ["2026-07-28"],
        versionNegotiation: { mode: { pin: "2026-07-28" } },
      },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${mcpOrigin}/mcp`)),
    );
    const listedBooks = resultValue(
      await client.callTool({
        name: "list_books",
        arguments: { sort: "newest" },
      }),
    );
    const listedBook = (Array.isArray(listedBooks) ? listedBooks : [])
      .map(record)
      .find((entry) => entry?.bookId === bookId);
    expect(listedBook?.name).toBe(BOOK);
    const notebooks = resultValue(
      await client.callTool({
        name: "list_notebooks",
        arguments: { book_id: bookId },
      }),
    );
    const notebook = (Array.isArray(notebooks) ? notebooks : [])
      .map(record)
      .find(Boolean);
    const notebookId = typeof notebook?.id === "string" ? notebook.id : "";
    if (!notebookId) throw new Error("Could not find the fixture notebook");
    resultValue(
      await client.callTool({
        name: "create_notebook_cell",
        arguments: {
          book_id: bookId,
          notebook_id: notebookId,
          cell: {
            type: "image",
            label: "img-slot",
            slot: { row: 0, column: 0 },
          },
        },
      }),
    );
    await client.close();

    viteProcess = startProcess(
      [
        join(process.cwd(), "node_modules/vite/bin/vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        String(vitePort),
      ],
      { ...process.env, VIDEOBOOK_SERVER_URL: mcpOrigin },
    );
    await waitForHttp(appUrl, viteProcess, 200);
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/mcp", async (route) => {
      const calls = toolCalls(await requestBody(route));
      const searching = calls.some(
        (call) =>
          call.name === "search_library_moments" ||
          call.name === "search_moments",
      );
      if (!searching || interception === "none") {
        await route.continue();
        return;
      }
      await rewriteToolResults(route, (result) => {
        if (interception === "error") {
          return {
            ...result,
            content: [{ type: "text", text: ERROR_TEXT }],
            isError: true,
          };
        }
        const page = JSON.parse(toolResultText(result)) as {
          hits: Array<Record<string, unknown>>;
        };
        const hits = page.hits.map((hit) => ({
          ...hit,
          signals: (Array.isArray(hit.signals) ? hit.signals : []).map(
            (signal) => ({ ...record(signal), explanation: EXPLANATION }),
          ),
        }));
        return {
          ...result,
          content: [{ type: "text", text: JSON.stringify({ ...page, hits }) }],
        };
      });
    });
  }, 120_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await stopProcess(viteProcess);
    await stopProcess(mcpProcess);
    if (rootDir)
      await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function executedMarkers(target: Page): Promise<string[]> {
    return await target.evaluate(() =>
      Object.keys(window).filter((key) => key.startsWith("__xss")),
    );
  }

  async function activeInjectedElements(target: Page): Promise<number> {
    return await target.evaluate(
      () =>
        document.querySelectorAll(
          'img[src="x"], [onerror], [onload], svg[onload], a[href^="javascript:"]',
        ).length,
    );
  }

  async function search(target: Page, query: string): Promise<void> {
    const input = target.getByLabel("Search the library");
    await input.waitFor({ state: "visible", timeout: 30_000 });
    await expect
      .poll(async () => await input.isEnabled(), { timeout: MCP_ROUNDTRIP_MS })
      .toBe(true);
    await input.fill(query);
    await input.press("Enter");
  }

  it("renders hostile book names, labels and indexed excerpts as literal text without executing them", async () => {
    if (!page) throw new Error("Browser page was not initialized");
    await page.goto(`${appUrl}/library`, { waitUntil: "commit" });
    await search(page, "hostile-excerpt-marker");
    const card = page.locator(".moment-card");
    await card.first().waitFor({ state: "visible", timeout: MCP_ROUNDTRIP_MS });
    expect(await card.count()).toBe(1);
    expect(await card.locator("header strong").textContent()).toBe(
      `${BOOK} · ${LABEL}`,
    );
    expect(await card.locator(".moment-card-body > p").textContent()).toBe(
      EXCERPT,
    );
    expect(
      await card.locator(".reason-chips span").first().getAttribute("title"),
    ).toBe("Query terms matched indexed text");
    expect(
      await card.locator(".moment-card-media img").getAttribute("alt"),
    ).toBe(LABEL);
    expect(
      await page.locator(".command-result span").first().textContent(),
    ).toBe("Found 1 moments · ready");
    expect(await executedMarkers(page)).toEqual([]);
    expect(await activeInjectedElements(page)).toBe(0);
    expect(pageErrors).toEqual([]);
  }, 60_000);

  it("renders hostile signal explanations and search error text literally", async () => {
    if (!page) throw new Error("Browser page was not initialized");
    interception = "explanation";
    await search(page, "hostile-label-marker hostile-excerpt-marker");
    const chip = page.locator(".moment-card .reason-chips span").first();
    await expect
      .poll(async () => await chip.getAttribute("title"), {
        timeout: MCP_ROUNDTRIP_MS,
      })
      .toBe(EXPLANATION);
    expect(await chip.textContent()).toBe("metadata");
    interception = "error";
    await search(page, "hostile-excerpt-marker");
    const notice = page.locator(".command-result span").first();
    await expect
      .poll(async () => await notice.textContent(), {
        timeout: MCP_ROUNDTRIP_MS,
      })
      .toContain(ERROR_TEXT);
    expect(await page.locator(".command-result").getAttribute("role")).toBe(
      "status",
    );
    interception = "none";
    expect(await executedMarkers(page)).toEqual([]);
    expect(await activeInjectedElements(page)).toBe(0);
    expect(pageErrors).toEqual([]);
  }, 60_000);

  it("renders the hostile owning book name literally in the media library dialog", async () => {
    if (!page) throw new Error("Browser page was not initialized");
    await page.goto(appUrl, { waitUntil: "commit" });
    const opener = page.locator(".cell-media-slot-library").first();
    await opener.waitFor({ state: "visible", timeout: 30_000 });
    await opener.click();
    const dialog = page.locator('.media-library-dialog[role="dialog"]');
    await dialog.waitFor({ state: "visible", timeout: MCP_ROUNDTRIP_MS });
    const asset = dialog.locator(".media-library-asset").first();
    await asset.waitFor({ state: "visible", timeout: MCP_ROUNDTRIP_MS });
    expect(await asset.locator("small").textContent()).toBe(
      `${BOOK} · this book`,
    );
    expect(
      await asset
        .locator("button[aria-label]")
        .last()
        .getAttribute("aria-label"),
    ).toContain(`from ${BOOK}`);
    expect(artifactId).toBeTruthy();
    expect(await executedMarkers(page)).toEqual([]);
    expect(await activeInjectedElements(page)).toBe(0);
    expect(pageErrors).toEqual([]);
  }, 60_000);
});
