import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { allowsHttpRequest } from "./http-access.js";
import type { VoiceSession, VoiceSessions } from "./voice-session.js";

const authentication = z.object({ type: z.literal("authenticate"), token: z.string().length(64) }).strict();

export function attachVoiceAudio(server: Server, sessions: VoiceSessions): void {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16_000, perMessageDeflate: false });
  server.on("upgrade", (request, socket, head) => {
    const match = /^\/api\/voice\/([0-9a-f-]{36})\/audio$/u.exec(request.url ?? "");
    if (!match || !allowsHttpRequest(request.headers.host ?? "", request.headers.origin ?? null, typeof request.headers["sec-fetch-site"] === "string" ? request.headers["sec-fetch-site"] : null)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, connection => {
      let session: VoiceSession | undefined;
      let lastFrameAt = Date.now();
      let allowance = 0;
      const deadline = setTimeout(() => connection.close(1008, "Voice authentication timed out"), 5000);
      const stop = () => { clearTimeout(deadline); void session?.close("Voice audio connection ended. Start voice to reconnect."); };
      connection.on("error", stop);
      connection.on("close", stop);
      connection.on("message", (data, binary) => {
        try {
          if (!session) {
            if (binary) throw new Error("Authentication required");
            const parsed = authentication.parse(JSON.parse(data.toString()));
            const selected = sessions.get(match[1]!, parsed.token);
            selected.attachAudio(() => { if (connection.readyState === WebSocket.OPEN) connection.close(1000); });
            session = selected;
            allowance = session.inputRate * 4;
            clearTimeout(deadline);
            connection.send(JSON.stringify({ type: "ready" }));
            return;
          }
          if (!binary) throw new Error("Expected PCM audio");
          const frame = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.concat(data);
          const now = Date.now();
          allowance = Math.min(session.inputRate * 4, allowance + (now - lastFrameAt) * session.inputRate / 500) - frame.length;
          lastFrameAt = now;
          if (allowance < 0) throw new Error("Audio rate exceeded");
          session.appendAudio(frame);
        } catch {
          connection.close(1008, "Voice audio request rejected");
          stop();
        }
      });
    });
  });
  server.on("close", () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); });
}
