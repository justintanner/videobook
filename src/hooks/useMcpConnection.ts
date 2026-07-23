import { useMcp, type UseMcpResult } from "use-mcp/react";

const mcpUrl = new URL("/mcp", window.location.origin).toString();

export function useMcpConnection(): UseMcpResult {
  return useMcp({
    url: mcpUrl,
    clientName: "videobook",
    transportType: "http",
    autoReconnect: 3000,
  });
}
