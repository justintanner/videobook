// --- Time parsing (port of ~/clipfirst-mcp/src/time_parse.py) ---

const COLON_SUFFIX_RE = /\s*(?:s|sec|secs|second|seconds)\s*$/i;
const H = "(?:h|hr|hrs|hour|hours)";
const M = "(?:m|min|mins|minute|minutes)";
const S = "(?:s|sec|secs|second|seconds)";
const SHORTHAND_RE = new RegExp(
  `^(?:(\\d+)\\s*${H})?\\s*(?:(\\d+)\\s*${M})?\\s*(?:(\\d+(?:\\.\\d+)?)\\s*${S}?)?\\s*$`,
  "i",
);

function parseBareNumeric(text: string): number | undefined {
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

function parseColonFormat(text: string): number | undefined {
  if (!text.includes(":")) return undefined;
  const cleaned = text.replace(COLON_SUFFIX_RE, "");
  const parts = cleaned.split(":");
  if (parts.length !== 2 && parts.length !== 3) return undefined;
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return undefined;
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
}

function parseShorthand(text: string): number | undefined {
  const match = SHORTHAND_RE.exec(text);
  if (!match || !match.slice(1).some(Boolean)) return undefined;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseFloat(match[3] || "0");
  return hours * 3600 + minutes * 60 + seconds;
}

const PARSERS = [parseBareNumeric, parseColonFormat, parseShorthand];

function parseTime(input: string | number | undefined): number | undefined {
  if (input === undefined || input === "") return undefined;
  if (typeof input === "number") return input;
  const text = input.trim();
  if (!text) return undefined;
  for (const parser of PARSERS) {
    const result = parser(text);
    if (result !== undefined) return result;
  }
  throw new Error(`Cannot parse timestamp: ${JSON.stringify(input)}`);
}

export { parseTime };
