type ToolErrorResult = {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
};

// Structural subset of a ZodError — keeps us decoupled from which zod version
// the caller imports (apicity packages pin zod@3.x; videocity uses zod@4.x).
type ZodLikeError = {
  issues: ReadonlyArray<{
    path: ReadonlyArray<PropertyKey>;
    message: string;
  }>;
};

// Stand-in https URL for pre-upload apicity safeParse. Asset fields are typed
// as z.string().url() on the wire, but tools pass local @img-*/@vid-*/@aud-*
// slugs until the job uploads and substitutes real CDN URLs. Use this only
// for schema validation — never as the outbound provider payload.
export function slugAsPlaceholderUrl(slug: string): string {
  const bare = slug.replace(/^@/, "").trim();
  return `https://placeholder.local/${bare || "asset"}`;
}

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

// Standard MCP tool error from a plain message. Replaces the inline
// `{ isError: true as const, content: [{ type: "text" as const, text }] }`
// literals scattered through the tool handlers.
export function toolError(text: string): ToolErrorResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

export type NamedInput = { name: string; value: unknown };

// "provided" = a non-blank string, or an array with at least one non-blank entry.
function isProvided(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(isProvided);
  return value !== undefined && value !== null;
}

// Enforce a cross-field "at least one of these inputs must be provided" rule —
// the kind MCP's flat JSON-Schema input can't express. Returns a tool error
// naming every candidate when none are present, else null.
export function requireAtLeastOne(label: string, inputs: NamedInput[]): ToolErrorResult | null {
  if (inputs.some((i) => isProvided(i.value))) return null;
  return toolError(`${label} requires at least one of: ${inputs.map((i) => i.name).join(", ")}`);
}
