import type { Tool } from "use-mcp/react";
import { cn } from "@/lib/utils";
import { ACTION_GROUP } from "@/components/ui/interaction-states";

const dotClass: Record<string, string> = {
  ready: "bg-emerald-400",
  failed: "bg-destructive",
  discovering: "bg-amber-400",
  connecting: "bg-amber-400",
  loading: "bg-amber-400",
  authenticating: "bg-amber-400",
  pending_auth: "bg-amber-400",
};

interface McpStatusProps {
  state: string;
  tools: Tool[];
  error: string | undefined;
  retry: (() => void) | undefined;
}

export function McpStatus({ state, tools, error, retry }: McpStatusProps) {
  const ok = state === "ready";
  const dot = dotClass[state] ?? "bg-zinc-500";
  const showAside = !ok && (!!error || (state === "failed" && !!retry));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="flex items-center gap-2.5 font-mono text-2xl font-bold tracking-widest text-foreground">
 <span aria-hidden className="inline-block size-3.5 rounded-full bg-primary ring-4 ring-primary/25" />
        VIDEOCITY
      </h1>

      <div
        className={cn(
          "flex items-center gap-2.5 rounded-lg border px-4 py-3",
          ok ? "border-emerald-400/40 bg-emerald-400/10" : "border-border bg-card"
        )}
      >
 <span className={cn("size-2.5 rounded-full shrink-0", dot)} />
        <span className="font-mono text-sm font-medium text-foreground">
          MCP {ok ? "connected" : state}
        </span>
        {showAside && (
          <div className={ACTION_GROUP}>
            {error && <span className="min-w-0 truncate font-mono text-xs text-destructive">{error}</span>}
            {state === "failed" && retry && (
              <button
                onClick={retry}
                className="shrink-0 rounded border border-primary/40 bg-primary/10 px-3 py-1 font-mono text-xs text-primary transition-colors hover:bg-primary/20"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      {ok && tools.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-mono text-sm font-bold tracking-wider text-muted-foreground">
            Tools ({tools.length})
          </h2>
          <ul className="flex flex-col gap-1.5">
            {tools.map((tool: Tool) => (
              <li key={tool.name} className="rounded border border-border bg-card/70 px-3 py-2">
                <code className="font-mono text-xs text-primary">{tool.name}</code>
                {tool.description && (
                  <div className="mt-1 font-mono text-xs text-muted-foreground line-clamp-2">
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
