import type {
  Engine,
  NotebookCell,
  NotebookDocument,
} from "videobook-engine";
import type { BookManager } from "./book-manager.js";
import {
  notebookCellFingerprint,
  runNotebookCell,
  topologicalOrder,
} from "./jobs/run-notebook.js";
import { normalizeSceneVideo } from "./notebook-media-ops.js";
import {
  applyAnalysisResults,
  buildSevenStageScaffold,
  MULTYCULTY_FEATURES,
} from "./notebook-workflow.js";

type ArtifactRecord = {
  artifactId: string;
  slug: string;
  kind: string;
};

export const MULTYCULTY_FIXTURE_VERSION = 8;
export const MULTYCULTY_FIXTURE_OWNER = "multyculty-default";

const LEGACY_SPLIT_ROLES = [
  "scene-intro",
  "scene-culture",
  "scene-german",
  "scene-dialogue",
] as const;

const LEGACY_ANIMATE_ROLES = [
  "animate-intro",
  "animate-culture",
  "animate-german",
  "animate-dialogue",
] as const;

const SECTION_SLUGS = [
  "vid-section-intro",
  "vid-section-culture",
  "vid-section-german",
  "vid-section-dunka",
] as const;

const ANIMATION_SLUGS = [
  "vid-animated-intro",
  "vid-animated-culture",
  "vid-animated-german",
  "vid-animated-dunka",
] as const;

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

function isCanonicalRole(role: string | null): boolean {
  return /^label-\d+$/.test(role ?? "")
    || role === "source"
    || role === "analysis"
    || role === "source-audio"
    || role === "assembly"
    || role === "export"
    || /^split-\d+$/.test(role ?? "")
    || /^frame-(first|last)-\d+$/.test(role ?? "")
    || /^scene-audio-\d+$/.test(role ?? "")
    || /^prompt-\d+$/.test(role ?? "")
    || /^animate-\d+$/.test(role ?? "");
}

function isLegacyOwnedCell(cell: NotebookCell): boolean {
  const role = roleOf(cell);
  return isCanonicalRole(role)
    || role === "final"
    || LEGACY_SPLIT_ROLES.includes(role as (typeof LEGACY_SPLIT_ROLES)[number])
    || LEGACY_ANIMATE_ROLES.includes(role as (typeof LEGACY_ANIMATE_ROLES)[number])
    || /^@scene-\d+\s*\/\s*animate/i.test(cell.title)
    || (
      cell.type === "scene"
      && /^@scene-\d+/i.test(cell.title)
    )
    || /^@final\b/i.test(cell.title);
}

function fixtureRecord(document: NotebookDocument): Record<string, unknown> | null {
  const raw = document.properties?.multycultyFixture;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
}

function canonicalFixtureCells(document: NotebookDocument): NotebookCell[] {
  return document.cells.filter((cell) =>
    cell.inputs?.fixtureOwner === MULTYCULTY_FIXTURE_OWNER);
}

function isCurrentFixture(document: NotebookDocument): boolean {
  const fixture = fixtureRecord(document);
  const cells = canonicalFixtureCells(document);
  const roles = new Set(cells.map(roleOf));
  const cellIds = new Set(cells.map((cell) => cell.id));
  const edges = document.edges.filter((edge) =>
    cellIds.has(edge.source) && cellIds.has(edge.target));
  return fixture?.version === MULTYCULTY_FIXTURE_VERSION
    && cells.length === 33
    && roles.size === 33
    && edges.length === 60
    && roles.has("source")
    && roles.has("analysis")
    && roles.has("source-audio")
    && roles.has("assembly")
    && roles.has("export")
    && [1, 2, 3, 4].every((ordinal) =>
      roles.has(`label-${ordinal}`)
      && roles.has(`split-${ordinal}`)
      && roles.has(`frame-first-${ordinal}`)
      && roles.has(`frame-last-${ordinal}`)
      && roles.has(`scene-audio-${ordinal}`)
      && roles.has(`prompt-${ordinal}`)
      && roles.has(`animate-${ordinal}`));
}

function prepareLegacyBase(document: NotebookDocument): NotebookDocument {
  const exportCell = document.cells.find((cell) => roleOf(cell) === "export")
    ?? document.cells.find((cell) =>
      roleOf(cell) === "final" || /^@final\b/i.test(cell.title));
  const transformed = document.cells.map((cell) => {
    if (cell.id !== exportCell?.id) return cell;
    return {
      ...cell,
      type: "export" as const,
      provider: "local",
      model: undefined,
      operation: "export_master",
      tool: "ffmpeg",
      inputs: {
        ...(cell.inputs ?? {}),
        workflowRole: "export",
        orientation: "landscape",
        captions: "burn-in",
      },
    };
  });
  const retained = transformed.filter((cell) =>
    roleOf(cell) !== "final" || cell.id === exportCell?.id);
  return { ...document, cells: retained };
}

function ordinalFromLegacy(cell: NotebookCell): number | null {
  const section = Number(cell.inputs?.section);
  if (Number.isInteger(section) && section >= 1 && section <= 4) return section;
  const role = roleOf(cell);
  const canonical = role?.match(/^(?:split|animate)-(\d+)$/);
  if (canonical) return Number(canonical[1]);
  const legacySplit = LEGACY_SPLIT_ROLES.indexOf(
    role as (typeof LEGACY_SPLIT_ROLES)[number],
  );
  if (legacySplit >= 0) return legacySplit + 1;
  const legacyAnimate = LEGACY_ANIMATE_ROLES.indexOf(
    role as (typeof LEGACY_ANIMATE_ROLES)[number],
  );
  if (legacyAnimate >= 0) return legacyAnimate + 1;
  const title = cell.title.match(/@scene-(\d+)/i);
  return title ? Number(title[1]) : null;
}

function prepareLegacyBranches(
  document: NotebookDocument,
  analysisCellId: string,
): NotebookDocument {
  const splitByOrdinal = new Map<number, NotebookCell>();
  for (const cell of document.cells) {
    const ordinal = ordinalFromLegacy(cell);
    if (
      ordinal
      && (
        cell.type === "split"
        || cell.type === "scene"
        || LEGACY_SPLIT_ROLES.includes(
          roleOf(cell) as (typeof LEGACY_SPLIT_ROLES)[number],
        )
      )
      && !splitByOrdinal.has(ordinal)
    ) {
      splitByOrdinal.set(ordinal, cell);
    }
  }
  const animateByOrdinal = new Map<number, NotebookCell>();
  for (const cell of document.cells) {
    const ordinal = ordinalFromLegacy(cell);
    if (
      ordinal
      && cell.type === "video"
      && (
        roleOf(cell)?.startsWith("animate-")
        || /^@scene-\d+\s*\/\s*animate/i.test(cell.title)
      )
      && !animateByOrdinal.has(ordinal)
    ) {
      animateByOrdinal.set(ordinal, cell);
    }
  }
  const selectedIds = new Set([
    ...splitByOrdinal.values(),
    ...animateByOrdinal.values(),
  ].map((cell) => cell.id));
  const cells = document.cells
    .filter((cell) =>
      !isLegacyOwnedCell(cell)
      || selectedIds.has(cell.id)
      || isCanonicalRole(roleOf(cell)))
    .map((cell) => {
      const ordinal = ordinalFromLegacy(cell);
      if (ordinal && splitByOrdinal.get(ordinal)?.id === cell.id) {
        return {
          ...cell,
          type: "split" as const,
          provider: "local",
          model: undefined,
          operation: "split_range",
          tool: "ffmpeg",
          inputs: {
            ...(cell.inputs ?? {}),
            analysisCellId,
            workflowRole: `split-${ordinal}`,
            ordinal,
            startSeconds: (ordinal - 1) * 15,
            endSeconds: ordinal * 15,
          },
        };
      }
      if (ordinal && animateByOrdinal.get(ordinal)?.id === cell.id) {
        const split = splitByOrdinal.get(ordinal);
        return {
          ...cell,
          type: "video" as const,
          inputs: {
            ...(cell.inputs ?? {}),
            analysisCellId,
            ...(split ? { splitCellId: split.id } : {}),
            workflowRole: `animate-${ordinal}`,
            ordinal,
          },
        };
      }
      return cell;
    });
  const ownedIds = new Set(cells.filter(isLegacyOwnedCell).map((cell) => cell.id));
  return {
    ...document,
    cells,
    edges: document.edges.filter((edge) =>
      !ownedIds.has(edge.source) && !ownedIds.has(edge.target)),
  };
}

async function promptFixtureArtifact(
  engine: Engine,
  cell: NotebookCell,
): Promise<string> {
  const artifact = await engine.artifacts.create({
    kind: "script",
    name: `script ${cell.title} resolved prompt`,
  });
  if (!artifact.ok) throw new Error(artifact.error.message);
  const result = {
    version: 1,
    source: "multyculty-precomputed-fixture",
    originalPrompt: cell.prompt ?? "",
    resolvedPrompt: cell.prompt ?? "",
    featureId: cell.inputs?.featureId ?? null,
    featureBrief: cell.inputs?.featureBrief ?? null,
    shotContext: cell.inputs?.shotContext ?? null,
    audioContext: cell.inputs?.audioContext ?? null,
  };
  const written = await engine.files.write(
    artifact.value.artifactId,
    "prompt.json",
    JSON.stringify(result, null, 2),
  );
  if (!written.ok) throw new Error(written.error.message);
  return artifact.value.artifactId;
}

async function attachFixtureOutputs(
  engine: Engine,
  document: NotebookDocument,
  artifacts: ArtifactRecord[],
): Promise<NotebookDocument> {
  const promptOutputs = new Map<string, string>();
  for (const cell of document.cells) {
    if (roleOf(cell)?.startsWith("prompt-") && !cell.outputArtifactId) {
      promptOutputs.set(cell.id, await promptFixtureArtifact(engine, cell));
    }
  }
  const finalArtifact = artifacts.find((artifact) => artifact.slug === "final");
  return {
    ...document,
    cells: document.cells.map((cell) => {
      const role = roleOf(cell);
      const ordinal = ordinalFromLegacy(cell);
      const feature = ordinal ? MULTYCULTY_FEATURES[ordinal - 1] : undefined;
      const section = ordinal
        ? artifacts.find((artifact) => artifact.slug === SECTION_SLUGS[ordinal - 1])
        : undefined;
      const animation = ordinal
        ? artifacts.find((artifact) => artifact.slug === ANIMATION_SLUGS[ordinal - 1])
        : undefined;
      const promptOutput = promptOutputs.get(cell.id);
      const outputArtifactId = role?.startsWith("split-")
        ? cell.outputArtifactId ?? section?.artifactId
        : role?.startsWith("animate-")
          ? cell.outputArtifactId ?? animation?.artifactId
          : role?.startsWith("prompt-")
            ? cell.outputArtifactId ?? promptOutput
            : role === "export"
              ? cell.outputArtifactId ?? finalArtifact?.artifactId
              : cell.outputArtifactId;
      const completed = Boolean(outputArtifactId)
        && (
          role === "source"
          || role === "analysis"
          || role === "export"
          || role?.startsWith("split-")
          || role?.startsWith("prompt-")
          || role?.startsWith("animate-")
        );
      return {
        ...cell,
        ...(outputArtifactId ? { outputArtifactId } : {}),
        inputs: {
          ...(cell.inputs ?? {}),
          fixtureOwner: MULTYCULTY_FIXTURE_OWNER,
          ...(feature
            ? {
                featureId: feature.id,
                featureLabel: feature.label,
                featureCaption: feature.caption,
              }
            : {}),
          ...(role?.startsWith("animate-")
            ? {
                fixtureBaseline: true,
                requiresConfirmation: true,
              }
            : {}),
          ...(role?.startsWith("prompt-")
            ? { resolvedPrompt: cell.prompt ?? "" }
            : {}),
          state: completed ? "completed" : "pending",
        },
      };
    }),
  };
}

function fixtureExecution(document: NotebookDocument): Record<string, unknown> {
  const raw = document.properties?.execution;
  const execution = raw && typeof raw === "object" && !Array.isArray(raw)
    ? { ...raw as Record<string, unknown> }
    : {};
  const completedAt = new Date().toISOString();
  for (const cell of canonicalFixtureCells(document)) {
    if (!cell.outputArtifactId) continue;
    execution[cell.id] = {
      status: "completed",
      outputArtifactId: cell.outputArtifactId,
      completedAt,
      fixtureBaseline: true,
    };
  }
  return execution;
}

async function writeNotebook(
  engine: Engine,
  document: NotebookDocument,
): Promise<NotebookDocument> {
  const written = await engine.notebooks.write(document);
  if (!written.ok) throw new Error(written.error.message);
  const read = engine.notebooks.read(document.id);
  if (!read.ok) throw new Error(read.error.message);
  return read.value;
}

async function runFixtureRole(
  engine: Engine,
  document: NotebookDocument,
  role: string,
): Promise<NotebookDocument> {
  const cell = document.cells.find((candidate) => roleOf(candidate) === role);
  if (!cell) throw new Error(`Multyculty fixture cell is missing: ${role}`);
  const result = await runNotebookCell(
    engine,
    engine.book.get().bookId,
    document.id,
    document,
    cell,
  );
  return result.document;
}

async function materializeLocalOutputs(
  engine: Engine,
  document: NotebookDocument,
): Promise<NotebookDocument> {
  let current = await runFixtureRole(engine, document, "source");
  current = await runFixtureRole(engine, current, "analysis");
  for (const ordered of topologicalOrder(current)) {
    if (
      ordered.inputs?.fixtureOwner !== MULTYCULTY_FIXTURE_OWNER
      || (
        ordered.type !== "split"
        && ordered.type !== "audio"
        && ordered.type !== "frame"
      )
    ) {
      continue;
    }
    const cell = current.cells.find((candidate) => candidate.id === ordered.id);
    if (!cell) throw new Error(`Multyculty fixture cell disappeared: ${ordered.id}`);
    const result = await runNotebookCell(
      engine,
      engine.book.get().bookId,
      current.id,
      current,
      cell,
    );
    current = result.document;
  }
  for (const feature of MULTYCULTY_FEATURES) {
    const animation = current.cells.find((cell) =>
      roleOf(cell) === `animate-${feature.ordinal}`);
    const audio = current.cells.find((cell) =>
      roleOf(cell) === `scene-audio-${feature.ordinal}`);
    if (!animation?.outputArtifactId || !audio?.outputArtifactId) {
      throw new Error(`Multyculty feature ${feature.ordinal} is missing baseline media`);
    }
    const normalized = await normalizeSceneVideo(
      engine,
      animation.outputArtifactId,
      audio.outputArtifactId,
      `${animation.title} normalized fixture`,
      15,
    );
    current = await writeNotebook(engine, {
      ...current,
      cells: current.cells.map((cell) =>
        cell.id === animation.id
          ? {
              ...cell,
              outputArtifactId: normalized.artifactId,
              inputs: {
                ...(cell.inputs ?? {}),
                normalizedFromArtifactId: animation.outputArtifactId,
                normalizedDurationSeconds: normalized.durationSeconds,
                state: "completed",
              },
            }
          : cell),
    });
  }
  current = await runFixtureRole(engine, current, "assembly");
  current = await runFixtureRole(engine, current, "export");
  const completedAt = new Date().toISOString();
  const completedCells = current.cells.map((cell) =>
    cell.inputs?.fixtureOwner === MULTYCULTY_FIXTURE_OWNER
      && cell.outputArtifactId
      ? {
          ...cell,
          inputs: {
            ...(cell.inputs ?? {}),
            state: "completed",
          },
        }
      : cell);
  const completedDocument = { ...current, cells: completedCells };
  const execution = {
    ...fixtureExecution(completedDocument),
  };
  for (const cell of completedCells) {
    if (
      cell.inputs?.fixtureOwner !== MULTYCULTY_FIXTURE_OWNER
      || !cell.outputArtifactId
    ) {
      continue;
    }
    execution[cell.id] = {
      status: "completed",
      fingerprint: notebookCellFingerprint(completedDocument, cell),
      outputArtifactId: cell.outputArtifactId,
      completedAt,
      updatedAt: completedAt,
      fixtureBaseline: true,
    };
  }
  const fixture = fixtureRecord(completedDocument) ?? {};
  return writeNotebook(engine, {
    ...completedDocument,
    properties: {
      ...(completedDocument.properties ?? {}),
      execution,
      state: "finished",
      multycultyFixture: {
        ...fixture,
        materializedAt: completedAt,
        noPaidCalls: true,
      },
    },
  });
}

export async function seedMultycultyWorkflow(
  engine: Engine,
  options: {
    materializeLocalOutputs?: boolean;
  } = {},
): Promise<NotebookDocument> {
  if (engine.book.get().slug !== "multyculty") {
    throw new Error("The Multyculty workflow can only seed the multyculty book");
  }
  const notebook = engine.notebooks.list().find((candidate) =>
    candidate.name.toLowerCase() === "multyculty")
    ?? engine.notebooks.list()[0];
  if (!notebook) throw new Error("The Multyculty book has no notebook");
  if (isCurrentFixture(notebook)) {
    const fixture = fixtureRecord(notebook);
    if (
      options.materializeLocalOutputs
      && typeof fixture?.materializedAt !== "string"
    ) {
      return materializeLocalOutputs(engine, notebook);
    }
    return notebook;
  }

  const artifacts = engine.artifacts.list() as ArtifactRecord[];
  const sourceArtifact = requiredArtifact(artifacts, "vid-source-selection");
  const streams = engine.streams.list(sourceArtifact.artifactId);
  if (!streams.ok) throw new Error(streams.error.message);
  const sourceAudio = streams.value.find((stream) => stream.kind === "audio");
  if (!sourceAudio) throw new Error("The Multyculty source has no audio stream");
  const previousRevision = engine.head;
  const preparedBase = prepareLegacyBase(notebook);
  const scaffold = buildSevenStageScaffold(
    engine,
    preparedBase,
    sourceArtifact.artifactId,
  );
  const source = scaffold.cells.find((cell) => roleOf(cell) === "source");
  const analysis = scaffold.cells.find((cell) => roleOf(cell) === "analysis");
  if (!source || !analysis) {
    throw new Error("Multyculty scaffold missing source/analysis cells");
  }
  const preparedBranches = buildSevenStageScaffold(
    engine,
    prepareLegacyBranches(scaffold, analysis.id),
    sourceArtifact.artifactId,
  );
  const configured: NotebookDocument = {
    ...preparedBranches,
    cells: preparedBranches.cells.map((cell) => {
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
            streamId: sourceAudio.streamId,
            objectHash: sourceAudio.objectHash,
            state: "completed",
          },
        };
      }
      if (cell.id === analysis.id) {
        return {
          ...cell,
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
          outputArtifactId: undefined,
          inputs: {
            ...(cell.inputs ?? {}),
            artifactId: sourceArtifact.artifactId,
            streamId: sourceAudio.streamId,
            objectHash: sourceAudio.objectHash,
            state: "pending",
          },
        };
      }
      return cell;
    }),
  };
  const fanned = await applyAnalysisResults(
    engine,
    configured,
    analysis.id,
    {
      rawOutput: configured.cells.find((cell) => cell.id === analysis.id)?.inputs
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
  const withOutputs = await attachFixtureOutputs(engine, fanned, artifacts);
  const fixtureOwnedIds = new Set(
    withOutputs.cells
      .filter((cell) =>
        isCanonicalRole(roleOf(cell))
        || isLegacyOwnedCell(cell))
      .map((cell) => cell.id),
  );
  const migrated: NotebookDocument = {
    ...withOutputs,
    name: "Multyculty",
    cells: withOutputs.cells.map((cell) =>
      fixtureOwnedIds.has(cell.id)
        ? {
            ...cell,
            inputs: {
              ...(cell.inputs ?? {}),
              fixtureOwner: MULTYCULTY_FIXTURE_OWNER,
            },
          }
        : cell),
    properties: {
      ...(withOutputs.properties ?? {}),
      description:
        "Completed feature green path from source analysis through scene animation, canonical assembly, and export.",
      state: "finished",
      multycultyFixture: {
        version: MULTYCULTY_FIXTURE_VERSION,
        owner: MULTYCULTY_FIXTURE_OWNER,
        previousRevision,
        ensuredAt: new Date().toISOString(),
        noPaidCalls: true,
      },
    },
  };
  migrated.properties = {
    ...(migrated.properties ?? {}),
    execution: fixtureExecution(migrated),
  };
  const seeded = await writeNotebook(engine, migrated);
  return options.materializeLocalOutputs
    ? materializeLocalOutputs(engine, seeded)
    : seeded;
}

export async function ensureMultycultyWorkflow(
  books: BookManager,
  options: {
    materializeLocalOutputs?: boolean;
  } = {},
): Promise<{
  status: "skipped" | "unchanged" | "migrated";
  notebookId?: string;
  revision?: string;
}> {
  await books.ready();
  const selected = books.getBySlug("multyculty");
  if (!selected.ok) return { status: "skipped" };
  const notebook = selected.value.engine.notebooks.list().find((candidate) =>
    candidate.name.toLowerCase() === "multyculty")
    ?? selected.value.engine.notebooks.list()[0];
  if (!notebook) return { status: "skipped" };
  const source = selected.value.engine.artifacts.list().find((artifact) =>
    artifact.slug === "vid-source-selection");
  if (!source) return { status: "skipped" };
  const fixture = fixtureRecord(notebook);
  if (
    isCurrentFixture(notebook)
    && (
      !options.materializeLocalOutputs
      || typeof fixture?.materializedAt === "string"
    )
  ) {
    return {
      status: "unchanged",
      notebookId: notebook.id,
      revision: selected.value.engine.head,
    };
  }
  const migrated = await seedMultycultyWorkflow(
    selected.value.engine,
    options,
  );
  return {
    status: "migrated",
    notebookId: migrated.id,
    revision: selected.value.engine.head,
  };
}
