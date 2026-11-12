import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Engine, NotebookCell, NotebookEdge } from "videobook-engine";

export const LEGACY_GOAL_FIXTURES = ["v1-completed", "v2-four-panel", "v2-six-panel", "v3-finished", "v3-running"] as const;
export type LegacyGoalFixtureName = typeof LEGACY_GOAL_FIXTURES[number];

type LegacyGoalFixture = {
  store: "application.goals.v1" | "application.goals.v2";
  bookId: string;
  notebookId: string;
  goalId: string;
  record: Record<string, unknown>;
  cells: NotebookCell[];
  edges: NotebookEdge[];
  artifacts: { artifactId: string; kind: string; label: string | null }[];
  chainRuns: Record<string, unknown>;
};

const FIXTURE_DIR = join(import.meta.dirname, "../../tests/fixtures/goals/legacy");

export async function loadLegacyGoalFixture(engine: Engine, notebookId: string, name: LegacyGoalFixtureName, media: { image?: Buffer; video?: Buffer } = {}) {
  const fixture = JSON.parse(await readFile(join(FIXTURE_DIR, `${name}.json`), "utf8")) as LegacyGoalFixture;
  const ids = new Map<string, string>([[fixture.bookId, engine.book.get().bookId], [fixture.notebookId, notebookId]]);
  for (const artifact of fixture.artifacts) {
    const created = await engine.artifacts.create(artifact.kind, artifact.label ?? artifact.kind);
    if (!created.ok) throw new Error(created.error.message);
    ids.set(artifact.artifactId, created.value.artifactId);
    const bytes = artifact.kind === "video" ? media.video : media.image;
    if (bytes) {
      const written = await engine.files.write(created.value.artifactId, artifact.kind === "video" ? "original.mp4" : "original.png", bytes);
      if (!written.ok) throw new Error(written.error.message);
    }
  }
  const remap = <T>(value: T): T => JSON.parse([...ids].reduce((text, [from, to]) => text.split(from).join(to), JSON.stringify(value))) as T;
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  const offset = notebook.value.cells.length === 0 ? 0 : Math.max(...notebook.value.cells.map(cell => cell.slot.row)) + 1;
  const cells = remap(fixture.cells).map(cell => ({ ...cell, slot: { ...cell.slot, row: cell.slot.row + offset } }));
  const written = await engine.notebooks.write({ ...notebook.value, cells: [...notebook.value.cells, ...cells], edges: [...notebook.value.edges, ...remap(fixture.edges)] });
  if (!written.ok) throw new Error(written.error.message);
  const store = engine.settings.get<Record<string, unknown>>(fixture.store) ?? {};
  const stored = engine.settings.set(fixture.store, { ...store, [fixture.goalId]: remap(fixture.record) });
  if (!stored.ok) throw new Error(stored.error.message);
  const runs = engine.settings.get<{ runs: Record<string, unknown>; requestIndex: Record<string, string> }>("application.chain-runs.v1") ?? { runs: {}, requestIndex: {} };
  const saved = engine.settings.set("application.chain-runs.v1", { ...runs, runs: { ...runs.runs, ...remap(fixture.chainRuns) } });
  if (!saved.ok) throw new Error(saved.error.message);
  return { goalId: fixture.goalId, artifactIds: ids };
}
