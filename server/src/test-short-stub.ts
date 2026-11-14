import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type ShortStubSubmission = { path: string; body: Record<string, unknown> };

export type ShortStubMedia = { frame: Buffer; clip: Buffer; extended: Buffer };

export type ShortStub = {
  baseURL: string;
  submissions: ShortStubSubmission[];
  plannerRequests: unknown[];
  plannerAnswers: unknown[];
  unexpected: string[];
  media: ShortStubMedia;
  failNext: boolean;
  refuseNext: boolean;
  reset(): void;
  close(): Promise<void>;
};

export const SHORT_STUB_REFUSAL = "Request blocked by the content policy";

const FAL_STORAGE_HOST = "rest.fal.ai";
const FREE_HOSTS = new Set(["litterbox.catbox.moe", "uguu.se", "tmpfile.link"]);
const SUBMIT = /^\/(openai\/gpt-image-2\.6\/(?:sunburst|flare)\/(?:edit|text-to-image)|google\/nano-banana-2\.1\/edit|minimax\/h3-max\/(?:reference-to-video|extend-video))$/u;
const POLL = /^\/(?:openai\/gpt-image-2\.6|google\/nano-banana-2\.1|minimax\/h3-max)\/requests\/([^/]+)(\/status)?$/u;

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function responsesBody(text: string): string {
  return JSON.stringify({
    id: "resp_short", object: "response", created_at: 0, status: "completed", model: "gpt-6-astra",
    output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    instructions: null, previous_response_id: null, temperature: null, top_p: null, max_output_tokens: null,
    store: false, tools: [], reasoning: null, text: { format: { type: "text" } },
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 }, error: null, incomplete_details: null, metadata: {},
  });
}

function kindOf(path: string): "frame" | "clip" | "extend" {
  if (path.endsWith("/extend-video")) return "extend";
  return path.includes("h3-max") ? "clip" : "frame";
}

export async function startShortStub(media: ShortStubMedia): Promise<ShortStub> {
  const served = new Map<string, Buffer>();
  const failing = new Set<string>();
  const refused = new Set<string>();
  let counter = 0;
  const stub: ShortStub = {
    baseURL: "",
    submissions: [],
    plannerRequests: [],
    plannerAnswers: [],
    unexpected: [],
    media,
    failNext: false,
    refuseNext: false,
    reset() {
      stub.submissions = [];
      stub.plannerRequests = [];
      stub.plannerAnswers = [];
      stub.unexpected = [];
      stub.failNext = false;
      failing.clear();
      refused.clear();
      stub.refuseNext = false;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const route = (method: string, path: string, body: Buffer, response: ServerResponse, query: URLSearchParams): void => {
    if (method === "POST" && path === "/api/v1/jobs/createTask") {
      const id = `frame-${++counter}`;
      if (stub.failNext) failing.add(id);
      stub.failNext = false;
      served.set(id, stub.media.frame);
      stub.submissions.push({ path, body: JSON.parse(body.toString()) as Record<string, unknown> });
      return sendJson(response, { code: 200, msg: "success", data: { taskId: id } });
    }
    if (method === "GET" && path === "/api/v1/jobs/recordInfo") {
      const id = query.get("taskId") ?? "";
      return sendJson(response, { code: 200, msg: "success", data: failing.has(id)
        ? { taskId: id, state: "fail", failCode: "422", failMsg: SHORT_STUB_REFUSAL, completeTime: Date.now() }
        : { taskId: id, state: "success", resultJson: JSON.stringify({ resultUrls: [`${stub.baseURL}/files/${id}.png`] }) } });
    }
    if (method === "POST" && path === "/api/file-stream-upload") {
      return sendJson(response, { code: 200, msg: "success", data: { downloadUrl: `${stub.baseURL}/files/kie-upload-${++counter}.png` } });
    }
    if (method === "POST" && SUBMIT.test(path)) {
      const kind = kindOf(path);
      const id = `${kind}-${++counter}`;
      if (stub.refuseNext) refused.add(id);
      stub.refuseNext = false;
      if (stub.failNext) failing.add(id);
      stub.failNext = false;
      served.set(id, kind === "frame" ? stub.media.frame : kind === "clip" ? stub.media.clip : stub.media.extended);
      stub.submissions.push({ path, body: JSON.parse(body.toString()) as Record<string, unknown> });
      return sendJson(response, { request_id: id, status: "IN_QUEUE" });
    }
    const poll = POLL.exec(path);
    if (method === "GET" && poll) {
      const id = poll[1]!;
      if (poll[2]) return sendJson(response, failing.has(id) ? { status: "COMPLETED", error: SHORT_STUB_REFUSAL } : { status: "COMPLETED" });
      if (refused.has(id)) {
        response.writeHead(422, { "content-type": "application/json" });
        response.end(JSON.stringify({ detail: [{ loc: ["body"], msg: "The content could not be processed because it contained material flagged by a content checker.", type: "content_policy_violation", url: "https://docs.fal.ai/errors#content_policy_violation", input: "", categories: ["model_moderated"] }] }));
        return;
      }
      return sendJson(response, id.startsWith("frame")
        ? { images: [{ url: `${stub.baseURL}/files/${id}.png`, content_type: "image/png" }] }
        : { video: { url: `${stub.baseURL}/files/${id}.mp4`, content_type: "video/mp4" } });
    }
    const file = /^\/files\/([^/.]+)\.(png|mp4)$/u.exec(path);
    if (method === "GET" && file && served.has(file[1]!)) {
      response.writeHead(200, { "content-type": file[2] === "mp4" ? "video/mp4" : "image/png" });
      response.end(served.get(file[1]!));
      return;
    }
    if (method === "POST" && path === `/${FAL_STORAGE_HOST}/storage/upload/initiate`) {
      const { file_name: name } = JSON.parse(body.toString()) as { file_name: string };
      return sendJson(response, { file_url: `${stub.baseURL}/files/uploaded-${name}`, upload_url: `${stub.baseURL}/fal-storage/${name}` });
    }
    if (method === "PUT" && path.startsWith("/fal-storage/")) {
      response.end();
      return;
    }
    if (method === "POST" && path.endsWith("/responses")) {
      stub.plannerRequests.push(JSON.parse(body.toString()));
      const answer = stub.plannerAnswers.shift();
      response.writeHead(answer === undefined ? 500 : 200, { "content-type": "application/json" });
      response.end(answer === undefined ? JSON.stringify({ error: { message: "no answer queued" } }) : responsesBody(JSON.stringify(answer)));
      return;
    }
    stub.unexpected.push(`${method} ${path}`);
    response.writeHead(FREE_HOSTS.has(path.split("/")[1] ?? "") ? 503 : 404).end();
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      route(request.method ?? "", url.pathname, Buffer.concat(chunks), response, url.searchParams);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}

export function redirectFalStorage(baseURL: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname === FAL_STORAGE_HOST || FREE_HOSTS.has(url.hostname)
      ? original(`${baseURL}/${url.hostname}${url.pathname}${url.search}`, init)
      : original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}
