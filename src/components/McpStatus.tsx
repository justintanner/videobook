import type { Tool } from "use-mcp/react";

const dot: Record<string, string> = {
  ready: "#22c55e",
  failed: "#ef4444",
  discovering: "#eab308",
  connecting: "#eab308",
  loading: "#eab308",
  authenticating: "#eab308",
  pending_auth: "#eab308",
};

interface McpStatusProps {
  state: string;
  tools: Tool[];
  error: string | undefined;
  retry: (() => void) | undefined;
}

export function McpStatus({ state, tools, error, retry }: McpStatusProps) {
  const color = dot[state] ?? "#888";
  const ok = state === "ready";

  return (
    <div>
      <h1>Clipfirst</h1>

      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "0.6rem",
        padding: "0.75rem 1rem",
        borderRadius: 8,
        border: `1px solid ${color}40`,
        background: `${color}10`,
        marginBottom: "1.5rem",
      }}>
        <span style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
        }} />
        <span style={{ fontWeight: 500 }}>
          MCP {ok ? "connected" : state}
        </span>
        {!ok && error && (
          <span style={{ color: "#ef4444", marginLeft: "auto", fontSize: "0.875rem" }}>
            {error}
          </span>
        )}
        {state === "failed" && retry && (
          <button onClick={retry} style={{ marginLeft: "auto", fontSize: "0.8rem", padding: "0.3em 0.8em" }}>
            Retry
          </button>
        )}
      </div>

      {ok && tools.length > 0 && (
        <section>
          <h2 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>Tools ({tools.length})</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {tools.map((tool: Tool) => (
              <li key={tool.name} style={{
                padding: "0.5rem 0.75rem",
                borderRadius: 6,
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.08)",
              }}>
                <code style={{ fontSize: "0.9rem" }}>{tool.name}</code>
                {tool.description && (
                  <div style={{ fontSize: "0.8rem", opacity: 0.6, marginTop: "0.15rem" }}>
                    {tool.description}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
