import { useState, useCallback } from "react";
import type { UseMcpResult } from "use-mcp/react";

interface SkillParam {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
}

interface McpToolBinding {
  tool: string;
  autoInject?: string[];
}

interface Skill {
  command: string;
  description: string;
  example?: string;
  category: "action" | "project" | "context_menu";
  icon: string;
  size: "sm" | "default" | "lg";
  variant: "default" | "violet";
  chevron: "right" | "down";
  params: SkillParam[];
  mcpTool?: McpToolBinding;
  uiAction?: string;
}

interface UseSkillsResult {
  skills: Skill[];
  loading: boolean;
  error: string | undefined;
  refresh: () => void;
}

let cachedSkills: Skill[] = [];

export function useSkills(callTool: UseMcpResult["callTool"]): UseSkillsResult {
  const [skills, setSkills] = useState<Skill[]>(cachedSkills);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await callTool("skills", {});
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed: Skill[] = JSON.parse(content[0].text);
      const changed =
        parsed.length !== cachedSkills.length ||
        parsed.some((s, i) => s.command !== cachedSkills[i].command);
      if (changed) {
        cachedSkills = parsed;
        setSkills(parsed);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [callTool]);

  return { skills, loading, error, refresh };
}

export type { Skill, SkillParam, McpToolBinding };
