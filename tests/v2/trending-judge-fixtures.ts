import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { RESEARCH_JUDGE_MODEL } from "../../server/src/trending/judge.js";

interface CapturedContentPart {
  type: string;
  text?: string;
  image_url?: string;
  detail?: string;
}

export interface CapturedRequest {
  model: string;
  instructions: string;
  reasoning?: { effort?: string };
  store?: boolean;
  input: Array<{ role: string; content: CapturedContentPart[] }>;
  text?: {
    format?: {
      type: string;
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
  };
}

export function completedResponse(text: string, model = RESEARCH_JUDGE_MODEL): Record<string, unknown> {
  return {
    id: `resp_${Math.random().toString(36).slice(2, 10)}`,
    object: "response",
    created_at: 0,
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    instructions: null,
    previous_response_id: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    store: false,
    tools: [],
    reasoning: { effort: "low" },
    text: { format: { type: "text" } },
    usage: { input_tokens: 900, output_tokens: 80, total_tokens: 980 },
    error: null,
    incomplete_details: null,
    metadata: {},
  };
}

export function postTextOf(request: CapturedRequest): string {
  const part = request.input[0]?.content.find((entry) => entry.type === "input_text");
  return part?.text ?? "";
}

export function imagePartOf(request: CapturedRequest): CapturedContentPart | undefined {
  return request.input[0]?.content.find((entry) => entry.type === "input_image");
}

export function startServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

export async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
