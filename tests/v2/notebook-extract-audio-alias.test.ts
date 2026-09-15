import { describe, expect, it } from "vitest";
import type { NotebookDocument } from "videobook-engine";
import { migrateLegacyExtractAudioCells } from "../../server/src/notebook-cell-outputs.js";

/**
 * Reading a legacy `extract_audio` cell as an `audio` cell is a pure document
 * rewrite, so it is covered here rather than behind an engine, a queue and an
 * FFmpeg run. notebook-audio-extract-action.test.ts keeps the half that has to
 * be real: the tool enqueueing a job whose output carries provenance.
 */
function document(
  cells: NotebookDocument["cells"],
  edges: NotebookDocument["edges"] = [],
): NotebookDocument {
  return {
    id: "nb-1",
    name: "Main",
    cells,
    edges,
    createdAt: "2026-09-15T00:00:00.000Z",
  };
}

const sourceCell: NotebookDocument["cells"][number] = {
  id: "cell-source",
  type: "video",
  label: "Source video",
  slot: { row: 0, column: 0 },
  outputArtifactId: "artifact-video",
};

function legacyExtract(
  overrides: Partial<NotebookDocument["cells"][number]> = {},
): NotebookDocument["cells"][number] {
  return {
    id: "cell-extract",
    type: "extract_audio",
    label: "Legacy extract",
    slot: { row: 1, column: 0 },
    provider: "local",
    operation: "extract_audio",
    tool: "ffmpeg",
    ...overrides,
  };
}

const videoEdge: NotebookDocument["edges"][number] = {
  id: "edge-video",
  source: "cell-source",
  target: "cell-extract",
  targetInput: "video",
};

function aliasedExtract(input: NotebookDocument) {
  return migrateLegacyExtractAudioCells(input).cells
    .find((cell) => cell.id === "cell-extract");
}

describe("migrateLegacyExtractAudioCells", () => {
  it("reads a legacy extract cell as its own audio output", () => {
    expect(aliasedExtract(document([sourceCell, legacyExtract()], [videoEdge])))
      .toMatchObject({
        type: "audio",
        inputs: {
          mediaRole: "extract-audio-output",
          sourceCellId: "cell-source",
        },
      });
  });

  it("clears the producer fields, since the cell is now the output", () => {
    const aliased = aliasedExtract(
      document([sourceCell, legacyExtract()], [videoEdge]),
    );
    expect(aliased).toMatchObject({
      operation: undefined,
      provider: undefined,
      model: undefined,
      tool: undefined,
    });
  });

  it("retargets the incoming video edge as the segment it now carries", () => {
    const { edges } = migrateLegacyExtractAudioCells(
      document([sourceCell, legacyExtract()], [videoEdge]),
    );
    expect(edges).toEqual([{ ...videoEdge, targetInput: "segment" }]);
  });

  it("takes an existing output artifact as proof the extract completed", () => {
    expect(aliasedExtract(document(
      [sourceCell, legacyExtract({ outputArtifactId: "artifact-audio" })],
      [videoEdge],
    ))).toMatchObject({
      outputArtifactId: "artifact-audio",
      inputs: expect.objectContaining({ state: "completed" }),
    });
  });

  it("drops an awaiting-output state that no longer has an output to await", () => {
    const aliased = aliasedExtract(document(
      [sourceCell, legacyExtract({ inputs: { state: "awaiting-output" } })],
      [videoEdge],
    ));
    expect(aliased?.inputs).not.toHaveProperty("state");
  });

  it("drops producerCellId, which pointed at the cell it has replaced", () => {
    const aliased = aliasedExtract(document(
      [sourceCell, legacyExtract({ inputs: { producerCellId: "cell-extract" } })],
      [videoEdge],
    ));
    expect(aliased?.inputs).not.toHaveProperty("producerCellId");
    expect(aliased?.inputs).toMatchObject({ sourceCellId: "cell-source" });
  });

  it("records no source when the legacy cell was never wired to a video", () => {
    const aliased = aliasedExtract(document([legacyExtract()]));
    expect(aliased).toMatchObject({ type: "audio" });
    expect(aliased?.inputs).not.toHaveProperty("sourceCellId");
  });

  it("returns the same document when there is nothing legacy in it", () => {
    const input = document([sourceCell], []);
    expect(migrateLegacyExtractAudioCells(input)).toBe(input);
  });
});
