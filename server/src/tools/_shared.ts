type ToolErrorResult = {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
};

// Structural subset of a ZodError — keeps us decoupled from which zod version
// the caller imports (apicity packages pin zod@3.x; clipfirst uses zod@4.x).
type ZodLikeError = {
  issues: ReadonlyArray<{
    path: ReadonlyArray<PropertyKey>;
    message: string;
  }>;
};

// Convert a ZodError from an @apicity provider safeParse into an MCP tool
// `isError` result. Strips the leading `input.` path segment so the surfaced
// message reads as "image_url: ..." rather than "input.image_url: ..." —
// MCP callers don't care about apicity's internal request envelope.
export function zodErrorToToolResult(err: ZodLikeError): ToolErrorResult {
  const lines = err.issues.map((issue) => {
    const path = issue.path.filter((seg) => seg !== "input").join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}
