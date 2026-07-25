import type {
  Engine,
  NotebookCell,
  NotebookDocument,
} from "videobook-engine";
import { applyAnalysisResults, buildSevenStageScaffold, WORKFLOW_STAGES } from "./notebook-workflow.js";

type ArtifactRecord = {
  artifactId: string;
  slug: string;
  kind: string;
};

function requiredArtifact(
  artifacts: ArtifactRecord[],
  slug: string,
): ArtifactRecord {
  const artifact = artifacts.find((candidate) => candidate.slug === slug);
  if (!artifact) throw new Error(`Multyculty fixture artifact is missing: ${slug}`);
  return artifact;
}

function roleOf(cell: NotebookCell): string | null {
  return typeof cell.inputs?.workflowRole === "string"
    ? cell.inputs.workflowRole
    : null;
}

/**
 * Seed / rematerialize the Multyculty notebook as a seven-stage runnable DAG.
 * Animation/assembly/export remain pending (no paid generation). Historical
 * section/animation artifacts stay available as stale previews when present.
 */
export async function seedMultycultyWorkflow(
  engine: Engine,
): Promise<NotebookDocument> {
  if (engine.book.get().slug !== "multyculty") {
    throw new Error("The Multyculty workflow can only seed the multyculty book");
  }
  const notebook = engine.notebooks.list().find((candidate) =>
    candidate.name.toLowerCase() === "multyculty")
    ?? engine.notebooks.list()[0];
  if (!notebook) throw new Error("The Multyculty book has no notebook");

  const artifacts = engine.artifacts.list() as ArtifactRecord[];
  const sourceArtifact = requiredArtifact(artifacts, "vid-source-selection");
  const streams = engine.streams.list(sourceArtifact.artifactId);
  if (!streams.ok) throw new Error(streams.error.message);
  const sourceAudio = streams.value.find((stream) => stream.kind === "audio");
  if (!sourceAudio) throw new Error("The Multyculty source has no audio stream");

  const scaffold = buildSevenStageScaffold(
    engine,
    notebook,
    sourceArtifact.artifactId,
  );
  const source = scaffold.cells.find((cell) => roleOf(cell) === "source");
  const analysis = scaffold.cells.find((cell) => roleOf(cell) === "analysis");
  if (!source || !analysis) {
    throw new Error("Multyculty scaffold missing source/analysis cells");
  }

  const withSource = {
    ...scaffold,
    cells: scaffold.cells.map((cell) => {
      if (cell.id === source.id) {
        return {
          ...cell,
          outputArtifactId: sourceArtifact.artifactId,
          inputs: {
            ...(cell.inputs ?? {}),
            sourceProject: "multiculty",
            sourceTitle: "We Were WRONG About Rupert Lowe",
            sourceUrl: "https://www.youtube.com/watch?v=b-3853ow72Q",
            selectedRangeSeconds: [1490, 1550],
            operation: "download_video",
            streamId: sourceAudio.streamId,
            objectHash: sourceAudio.objectHash,
            state: "completed",
          },
        };
      }
      if (cell.id === analysis.id) {
        return {
          ...cell,
          prompt: cell.prompt
            ?? "Segment the Multyculty selection into continuous narrative shots.",
          inputs: {
            ...(cell.inputs ?? {}),
            sourceDurationSeconds: 60,
            fixtureAnalysis: {
              scenes: [
                { title: "intro", timestamp: [0, 15] },
                { title: "culture", timestamp: [15, 30] },
                { title: "german", timestamp: [30, 45] },
                { title: "dialogue", timestamp: [45, 60] },
              ],
            },
            state: "pending",
          },
        };
      }
      if (roleOf(cell) === "source-audio") {
        return {
          ...cell,
          inputs: {
            ...(cell.inputs ?? {}),
            artifactId: sourceArtifact.artifactId,
            streamId: sourceAudio.streamId,
            objectHash: sourceAudio.objectHash,
            state: "pending",
          },
        };
      }
      if (roleOf(cell) === "assembly" || roleOf(cell) === "export") {
        return {
          ...cell,
          inputs: {
            ...(cell.inputs ?? {}),
            state: "pending",
            requiresConfirmation: roleOf(cell) === "export" ? false : true,
          },
        };
      }
      return cell;
    }),
  };

  // Attach legacy animation outputs as stale previews on matching animate cells
  // after fixture analysis fan-out, without running paid generation.
  const fanned = await applyAnalysisResults(
    engine,
    withSource,
    analysis.id,
    {
      rawOutput: withSource.cells.find((cell) => cell.id === analysis.id)?.inputs
        ?.fixtureAnalysis,
      sourceDurationSeconds: 60,
      request: {
        mode: "multyculty-fixture",
        provider: "kie",
        model: "gemini-3.5-flash",
      },
      sourceArtifactId: sourceArtifact.artifactId,
    },
  );

  const previewSlugs = [
    "vid-animated-intro",
    "vid-animated-culture",
    "vid-animated-german",
    "vid-animated-dunka",
  ];
  const animateCells = fanned.cells
    .filter((cell) => cell.type === "video")
    .sort((left, right) => left.position.x - right.position.x);
  const withPreviews: NotebookDocument = {
    ...fanned,
    cells: fanned.cells.map((cell) => {
      const animateIndex = animateCells.findIndex((candidate) => candidate.id === cell.id);
      if (animateIndex < 0) return cell;
      const slug = previewSlugs[animateIndex];
      if (!slug) return cell;
      const preview = artifacts.find((artifact) => artifact.slug === slug);
      if (!preview) return cell;
      return {
        ...cell,
        outputArtifactId: preview.artifactId,
        inputs: {
          ...(cell.inputs ?? {}),
          state: "stale",
          previewOnly: true,
          requiresConfirmation: true,
        },
      };
    }),
    properties: {
      ...(fanned.properties ?? {}),
      stageLabels: [...WORKFLOW_STAGES],
      multycultyMaterializedAt: new Date().toISOString(),
    },
  };

  const written = await engine.notebooks.write(withPreviews);
  if (!written.ok) throw new Error(written.error.message);
  const read = engine.notebooks.read(withPreviews.id);
  if (!read.ok) throw new Error(read.error.message);
  return read.value;
}
