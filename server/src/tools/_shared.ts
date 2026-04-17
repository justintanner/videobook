import type { z } from "zod";

type ToolErrorResult = {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
};

// Convert a ZodError from an @apicity provider safeParse into an MCP tool
// `isError` result. Strips the leading `input.` path segment so the surfaced
// message reads as "image_url: ..." rather than "input.image_url: ..." —
// MCP callers don't care about apicity's internal request envelope.
export function zodErrorToToolResult(err: z.ZodError): ToolErrorResult {
  const lines = err.issues.map((issue) => {
    const path = issue.path.filter((seg) => seg !== "input").join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}
