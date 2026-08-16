import { describe, expect, it, vi } from "vitest";
import {
  parseDownloadResult,
  parseNewestBookId,
  queueVideobookDownload,
  readTextResult,
  type McpToolRequest,
  type VideobookMcpSession,
} from "./mcp.js";

const NEWEST_BOOK_ID = "018f47b5-2f5d-7e19-8f0b-123456789abc";
const OLDER_BOOK_ID = "018e47b5-2f5d-7e19-8f0b-123456789abc";

function textResult(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function createSession(responses: unknown[]): {
  session: VideobookMcpSession;
  calls: McpToolRequest[];
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const calls: McpToolRequest[] = [];
  let responseIndex = 0;
  const connect = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const session: VideobookMcpSession = {
    connect,
    callTool: async (request) => {
      calls.push(request);
      const response = responses[responseIndex];
      responseIndex += 1;
      return response;
    },
    close,
  };
  return { session, calls, connect, close };
}

describe("extension MCP response parsing", () => {
  it("selects the first UUID from the newest-first book list", () => {
    expect(parseNewestBookId(JSON.stringify([
      { bookId: NEWEST_BOOK_ID, createdAt: 200 },
      { bookId: OLDER_BOOK_ID, createdAt: 100 },
    ]))).toBe(NEWEST_BOOK_ID);
  });

  it.each([
    ["an empty list", "[]", "No Videobook books are available."],
    ["a non-list value", JSON.stringify({ books: [] }), "list_books returned an invalid book list."],
    ["a non-UUID book", JSON.stringify([{ bookId: "project-one" }]), "list_books did not return a UUID bookId"],
    ["invalid JSON", "{", "list_books returned invalid JSON."],
  ])("rejects %s", (_label, value, message) => {
    expect(() => parseNewestBookId(value)).toThrow(message);
  });

  it("parses download_video output", () => {
    expect(parseDownloadResult(JSON.stringify({
      assetId: "asset-1",
      job_id: "download-asset-1",
      status: "enqueued",
    }))).toEqual({
      assetId: "asset-1",
      jobId: "download-asset-1",
      status: "enqueued",
    });
  });

  it("rejects malformed and error tool results", () => {
    expect(() => readTextResult({ content: [] })).toThrow("MCP response did not include text content.");
    expect(() => readTextResult({
      isError: true,
      content: [{ type: "text", text: "server unavailable" }],
    })).toThrow("server unavailable");
    expect(() => parseDownloadResult(JSON.stringify({ status: "enqueued" }))).toThrow(
      "Download response did not include an asset and job id.",
    );
  });
});

describe("extension MCP queueing", () => {
  it("lists newest books and queues the URL against the first UUID", async () => {
    const setup = createSession([
      textResult([
        { bookId: NEWEST_BOOK_ID, createdAt: 200 },
        { bookId: OLDER_BOOK_ID, createdAt: 100 },
      ]),
      textResult({ assetId: "asset-1", job_id: "job-1", status: "enqueued" }),
    ]);

    await expect(queueVideobookDownload(
      "https://example.com/video",
      () => setup.session,
    )).resolves.toEqual({ assetId: "asset-1", jobId: "job-1", status: "enqueued" });
    expect(setup.calls).toEqual([
      {
        name: "list_books",
        arguments: { sort: "newest" },
      },
      {
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          book_id: NEWEST_BOOK_ID,
          full: true,
          export_videos: false,
        },
      },
    ]);
    expect(setup.connect).toHaveBeenCalledOnce();
    expect(setup.close).toHaveBeenCalledOnce();
  });

  it("closes the client after an MCP error", async () => {
    const setup = createSession([{
      isError: true,
      content: [{ type: "text", text: "list failed" }],
    }]);

    await expect(queueVideobookDownload(
      "https://example.com/video",
      () => setup.session,
    )).rejects.toThrow("list failed");
    expect(setup.calls).toHaveLength(1);
    expect(setup.close).toHaveBeenCalledOnce();
  });

  it("closes after connection failure without masking the original error", async () => {
    const close = vi.fn(async () => {
      throw new Error("close failed");
    });
    const session: VideobookMcpSession = {
      connect: async () => {
        throw new Error("connect failed");
      },
      callTool: async () => textResult([]),
      close,
    };

    await expect(queueVideobookDownload(
      "https://example.com/video",
      () => session,
    )).rejects.toThrow("connect failed");
    expect(close).toHaveBeenCalledOnce();
  });
});
