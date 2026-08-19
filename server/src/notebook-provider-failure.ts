import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { getActionSpec } from "./generation-registry.js";

interface NotebookProviderFailureReference {
  notebookId: string;
  cellId: string;
  providerArtifactId: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  alibaba: "Alibaba",
  elevenlabs: "ElevenLabs",
  fal: "Fal",
  google: "Google Flow",
  google_flow: "Google Flow",
  kie: "Kie",
  openai: "OpenAI",
  workflow: "Workflow",
  xai: "xAI",
};

const SENSITIVE_ENV_KEY = /(?:^|_)(?:api_key|access_key_id|secret_access_key|token|secret|password|authorization|credential)(?:_|$)/i;
const SENSITIVE_FIELD = /((?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|credential)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|Bearer\s+[^\s,;}\]]+|[^\s,;}\]]+)/gi;
const SENSITIVE_QUERY = /([?&](?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|signature|sig|credential|x-amz-credential|x-amz-signature|x-goog-signature)=)[^&\s"'<>]*/gi;
const REPUTATIONAL_FAILURE = /(?:PUBLIC_ERROR_REPUTATIONAL|\bREPUTATIONAL\b)/i;
const REPUTATIONAL_GUIDANCE = "Google's safety system flagged this as reputation-sensitive, often involving an identifiable person. Use fictional or stylized subjects, remove real-person references, reword the edit, or try a different provider.";

function providerCell(
  engine: Engine,
  reference: NotebookProviderFailureReference,
): NotebookCell | null {
  const notebook = engine.notebooks.read(reference.notebookId);
  if (!notebook.ok) return null;
  return notebook.value.cells.find((cell) => cell.id === reference.cellId) ?? null;
}

function providerLabel(cell: NotebookCell | null): string {
  const spec = cell ? getActionSpec(cell.tool ?? cell.model ?? "") : undefined;
  const key = cell?.provider?.trim() || spec?.provider;
  if (!key) return "Provider";
  return PROVIDER_LABELS[key.toLowerCase()]
    ?? key.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function redactEnvironmentSecrets(message: string): string {
  let safe = message;
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8 || !SENSITIVE_ENV_KEY.test(key)) continue;
    safe = safe.replaceAll(value, "[redacted]");
  }
  return safe;
}

function sanitizeProviderFailureMessage(message: string): string {
  const safe = redactEnvironmentSecrets(
    message
      .replace(SENSITIVE_FIELD, "$1[redacted]")
      .replace(SENSITIVE_QUERY, "$1[redacted]"),
  )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return safe.length > 800 ? `${safe.slice(0, 799)}…` : safe;
}

export function notebookProviderFailureMessage(
  engine: Engine,
  reference: NotebookProviderFailureReference,
): string {
  const fallback = `Provider output ${reference.providerArtifactId} failed`;
  const failure = engine.jobs.failures.read(reference.providerArtifactId);
  if (!failure.ok || !failure.value) return fallback;
  const message = sanitizeProviderFailureMessage(failure.value.message);
  const failCode = failure.value.failCode
    ? sanitizeProviderFailureMessage(failure.value.failCode).slice(0, 120)
    : "";
  if (!message && !failCode) return fallback;
  const technical = message || failCode;
  const detail = failCode && !technical.toLowerCase().includes(failCode.toLowerCase())
    ? `${technical} (${failCode})`
    : technical;
  const prefix = `${providerLabel(providerCell(engine, reference))} failed: ${detail}`;
  if (
    REPUTATIONAL_FAILURE.test(`${failCode} ${message}`)
    && !prefix.includes(REPUTATIONAL_GUIDANCE)
  ) {
    return `${prefix} — ${REPUTATIONAL_GUIDANCE}`;
  }
  return prefix;
}

export function hydrateNotebookProviderFailures(
  engine: Engine,
  document: NotebookDocument,
): NotebookDocument {
  const execution = document.execution ?? {};
  let changed = false;
  const hydrated = Object.fromEntries(Object.entries(execution).map(([cellId, state]) => {
    const providerArtifactId = state.providerArtifactId;
    if (
      state.status !== "error"
      || !providerArtifactId
      || state.error !== `Provider output ${providerArtifactId} failed`
    ) {
      return [cellId, state];
    }
    const error = notebookProviderFailureMessage(engine, {
      notebookId: document.id,
      cellId,
      providerArtifactId,
    });
    if (error === state.error) return [cellId, state];
    changed = true;
    return [cellId, { ...state, error }];
  }));
  return changed ? { ...document, execution: hydrated } : document;
}
