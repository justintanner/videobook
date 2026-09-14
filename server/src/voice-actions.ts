import { z } from "zod";
import type { Engine } from "videobook-engine";
import { notebookGridAddress } from "videobook-engine/notebook-grid";
import { buildRoutableTools } from "./chat-router.js";
import { getAllToolDefs } from "./tools/index.js";

export function discoverVoiceActions(engine: Engine, query: string) {
  const definitions = getAllToolDefs(engine);
  const tokens = query.toLowerCase().replaceAll(/[^a-z0-9]+/gu, " ").trim().split(/\s+/u)
    .filter(Boolean).map((token) => token === "relabel" ? "rename" : token === "copy" ? "duplicate" : token);
  const words = tokens.join(" ");
  const actions = buildRoutableTools(definitions);
  const subjects = new Set(["audio", "image", "video", "notebook", "asset", "book", "cell", "text", "script", "project", "media", "voice", "model", "frame"]);
  const operations = new Set(actions.map((action) => action.name.split("_")[0]!).filter((word) => !subjects.has(word)));
  const operation = tokens.find((token) => operations.has(token));
  return actions.map((action) => {
    const name = action.name.replaceAll("_", " ");
    const haystack = `${name} ${action.description}`.toLowerCase();
    const score = (name === words ? 100 : 0)
      + (operation && (action.name === operation || action.name.startsWith(`${operation}_`)) ? 100 : 0)
      + tokens.reduce((sum, token) => sum + (name.includes(token) ? 4 : haystack.includes(token) ? 1 : 0), 0);
    return { action, score };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.action.name.localeCompare(b.action.name))
    .slice(0, 8)
    .map(({ action }) => {
      const definition = definitions.find((candidate) => candidate.name === action.actualTool)!;
      const { book_id: _bookId, ...shape } = definition.schema;
      return {
        name: action.name,
        description: action.description,
        effect: action.effect,
        requiresReview: action.effect !== "read" && !action.autoApply,
        parameters: z.toJSONSchema(z.object(shape), { unrepresentable: "any" }),
      };
    });
}

export function voiceWorkspaceContext(engine: Engine, notebookId?: string) {
  const notebook = notebookId ? engine.notebooks.read(notebookId) : null;
  if (notebook && !notebook.ok) throw new Error(notebook.error.message);
  const entries = [
    ...engine.logs.read("chat", { limit: 12 }),
    ...engine.logs.read("voice-chat", { limit: 12 }),
  ].filter((entry) => !notebookId || !entry.notebookId || entry.notebookId === notebookId)
    .sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
  const messages = entries.filter((entry, index) => !entry.interrupted && (!entry.id || !entries.slice(index + 1).some((next) => next.id === entry.id))).slice(-12);
  return {
    book: engine.book.get().name,
    notebookId,
    cells: notebook?.ok ? notebook.value.cells.slice(0, 64).map((cell) => ({
      address: `@${notebookGridAddress(cell.slot)}`,
      cellId: cell.id,
      type: cell.type,
      label: cell.label,
      artifactId: cell.outputArtifactId,
    })) : [],
    additionalCells: notebook?.ok ? Math.max(0, notebook.value.cells.length - 64) : 0,
    recentConversation: messages.map((entry) => ({
      role: entry.role,
      text: String(entry.text ?? entry.message ?? "").slice(0, 2000),
    })),
  };
}
