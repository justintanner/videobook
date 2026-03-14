import { useState, useCallback } from "react";
import type { UseMcpResult } from "use-mcp/react";

interface CommandParam {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
}

interface McpToolBinding {
  tool: string;
  autoInject?: string[];
}

interface Command {
  command: string;
  description: string;
  example?: string;
  category: "action" | "project" | "context_menu";
  icon: string;
  size: "sm" | "default" | "lg";
  variant: "default" | "violet";
  chevron: "right" | "down";
  params: CommandParam[];
  mcpTool?: McpToolBinding;
  uiAction?: string;
}

interface UseCommandsResult {
  commands: Command[];
  loading: boolean;
  error: string | undefined;
  refresh: () => void;
}

let cachedCommands: Command[] = [];

export function useCommands(callTool: UseMcpResult["callTool"]): UseCommandsResult {
  const [commands, setCommands] = useState<Command[]>(cachedCommands);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await callTool("commands", {});
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed: Command[] = JSON.parse(content[0].text);
      const changed =
        parsed.length !== cachedCommands.length ||
        parsed.some((s, i) => s.command !== cachedCommands[i].command);
      if (changed) {
        cachedCommands = parsed;
        setCommands(parsed);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [callTool]);

  return { commands, loading, error, refresh };
}

export type { Command, CommandParam, McpToolBinding };
