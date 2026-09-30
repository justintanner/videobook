import { WebSocket, WebSocketServer } from "ws";

export interface XaiEndpointEvent {
  type?: string;
  item?: Record<string, unknown>;
  session?: { instructions?: string };
  [key: string]: unknown;
}

export interface ActivationScriptOptions {
  responseId?: string;
  itemId?: string;
  transcript?: string | null;
  audioChunks?: number;
}

function tonePcm(samples: number, hz = 440): Buffer {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * index) / 24_000) * 8_000), index * 2);
  }
  return buffer;
}

function toneChunks(chunks: number, samplesPerChunk = 480): string[] {
  return Array.from({ length: chunks }, () => tonePcm(samplesPerChunk).toString("base64"));
}

export function sendActivationResponse(send: (event: unknown) => void, options: ActivationScriptOptions = {}): void {
  const responseId = options.responseId ?? "activation-response";
  const itemId = options.itemId ?? "activation-item";
  let tick = 0;
  const event = (type: string, extra: Record<string, unknown>) => ({ type, event_id: `activation-${tick += 1}`, response_id: responseId, item_id: itemId, ...extra });
  send({ type: "response.created", event_id: "activation-created", response_id: responseId, response: { id: responseId } });
  for (const chunk of toneChunks(options.audioChunks ?? 4)) send(event("response.output_audio.delta", { delta: chunk }));
  send(event("response.output_audio.done", {}));
  const transcript = options.transcript === undefined ? "voice chat activated" : options.transcript;
  if (transcript !== null) {
    send(event("response.output_audio_transcript.delta", { delta: transcript }));
    send(event("response.output_audio_transcript.done", { transcript }));
  }
  send({ type: "response.done", event_id: "activation-done", response_id: responseId, response: { id: responseId, status: "completed", usage: { input_tokens: 8, output_tokens: 12 } } });
}

export class XaiRealtimeEndpoint {
  private readonly wss: WebSocketServer;
  private readonly listening: Promise<string>;
  private readonly connections: WebSocket[] = [];
  private sessions = 0;
  readonly sent: XaiEndpointEvent[] = [];
  onActivation: ((send: (event: unknown) => void, item: Record<string, unknown>) => void) | null = null;

  constructor() {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    this.listening = promise;
    this.wss.once("error", reject);
    this.wss.once("listening", () => {
      const address = this.wss.address();
      if (!address || typeof address === "string") { reject(new Error("No endpoint address")); return; }
      resolve(`ws://127.0.0.1:${address.port}`);
    });
    this.wss.on("connection", socket => {
      this.connections.push(socket);
      socket.on("message", data => {
        const event = JSON.parse(String(data)) as XaiEndpointEvent;
        this.sent.push(event);
        const send = (outgoing: unknown) => socket.send(JSON.stringify(outgoing));
        if (event.type === "session.update") send({ type: "session.updated", event_id: "configured" });
        if (event.type === "conversation.item.create" && event.item?.type === "force_message") {
          const index = this.sessions += 1;
          (this.onActivation ?? ((activationSend: (event: unknown) => void) => sendActivationResponse(activationSend, { responseId: `activation-response-${index}`, itemId: `activation-item-${index}` })))(send, event.item);
        }
      });
    });
  }

  listen(): Promise<string> {
    return this.listening;
  }

  get socket(): WebSocket {
    const socket = this.connections.at(-1);
    if (!socket) throw new Error("No endpoint connection");
    return socket;
  }

  send(event: unknown): void {
    this.socket.send(JSON.stringify(event));
  }

  forceMessageItems(): Record<string, unknown>[] {
    return this.sent
      .filter(event => event.type === "conversation.item.create" && event.item?.type === "force_message")
      .map(event => event.item!);
  }

  async close(): Promise<void> {
    for (const socket of this.connections.splice(0)) socket.terminate();
    await new Promise<void>(resolve => this.wss.close(() => resolve()));
  }
}
