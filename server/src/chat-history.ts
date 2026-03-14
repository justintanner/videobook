import type { ClipfirstFs } from "clipfirst-fs";

type ChatLine = {
  role: string;
  text?: string;
  tool?: string;
  message?: string;
  error?: boolean;
  ts?: number;
};

async function getRecentHistory(
  fs: ClipfirstFs,
  slug: string,
  limit = 10,
): Promise<ChatLine[]> {
  const raw = await fs.readLog("chat", slug, { limit });
  return raw as ChatLine[];
}

function formatHistoryForPrompt(lines: ChatLine[]): string {
  if (lines.length === 0) return "";

  const formatted = lines.map((line) => {
    if (line.role === "user") {
      return `User: ${line.text ?? ""}`;
    }
    const toolTag = line.tool ? `[${line.tool}] ` : "";
    return `Assistant: ${toolTag}${line.message ?? ""}`;
  });

  return `Recent conversation:\n${formatted.join("\n")}`;
}

export { getRecentHistory, formatHistoryForPrompt };
export type { ChatLine };
