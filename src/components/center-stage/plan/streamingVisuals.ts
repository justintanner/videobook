// Parse the plan analysis model's *streaming* JSON output into per-scene visual
// descriptions for a live "show your work" view. The model emits structured JSON
// like `{"visuals":[{"visual":"..."},{"visual":"..."}]}`; while it streams we get
// a growing prefix of that text. We surface each completed `"visual": "..."`
// string plus the trailing in-progress one, so scenes appear as they're written.

export interface StreamingVisuals {
  // Fully-written scene descriptions, in order.
  complete: string[];
  // The scene currently being written (no closing quote yet), or null.
  partial: string | null;
}

// Complete `"visual": "<value>"` — value allows escaped chars, stops at the
// first unescaped quote. Global so we can collect every closed scene.
const COMPLETE_VISUAL_RE = /"visual"\s*:\s*"((?:\\.|[^"\\])*)"/g;
// An open `"visual": "<value>` running to the end of the buffer (no closing
// quote yet) — the scene mid-stream. A trailing lone backslash (an escape whose
// second char hasn't streamed in yet) is consumed by `\\?` and dropped from the
// captured value. The `$` anchor makes only the final, still-open visual match.
const PARTIAL_VISUAL_RE = /"visual"\s*:\s*"((?:\\.|[^"\\])*)\\?$/;

function unescapeJsonString(inner: string): string {
  try {
    return JSON.parse(`"${inner}"`) as string;
  } catch {
    // Mid-stream the tail can end on a lone backslash or a raw control char that
    // JSON.parse rejects; fall back to a best-effort unescape.
    return inner
      .replace(/\\$/, "")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

export function extractStreamingVisuals(raw: string): StreamingVisuals {
  const complete: string[] = [];
  if (!raw) return { complete, partial: null };

  COMPLETE_VISUAL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMPLETE_VISUAL_RE.exec(raw)) !== null) {
    complete.push(unescapeJsonString(match[1]));
  }

  const partialMatch = PARTIAL_VISUAL_RE.exec(raw);
  const partial = partialMatch ? unescapeJsonString(partialMatch[1]) : null;

  return { complete, partial };
}
