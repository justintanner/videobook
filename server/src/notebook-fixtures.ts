import type { NotebookCell } from "videobook-engine";

export const MULTYCULTY_FIXTURE_OWNER = "multyculty-default";

export function analysisFixtureForCell(
  cell: Pick<NotebookCell, "inputs">,
): unknown | null {
  if (cell.inputs?.fixtureOwner === MULTYCULTY_FIXTURE_OWNER) return null;
  return cell.inputs?.fixtureAnalysis
    ?? cell.inputs?.analysisFixture
    ?? null;
}
