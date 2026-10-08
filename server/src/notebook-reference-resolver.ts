import type {
  Engine,
  NotebookCell,
  NotebookDocument,
} from "videobook-engine";
import {
  isUuidV7,
  resolveNotebookCellArtifactId,
} from "videobook-engine";
import {
  notebookGridAddress,
  notebookGridTag,
  parseNotebookGridAddress,
} from "videobook-engine/notebook-grid";
import {
  NOTEBOOK_GRID_ADDRESS_SOURCE,
  normalizeNotebookReference,
  replaceNotebookMentions,
  scanNotebookMentions,
} from "videobook-engine/notebook-mentions";
import {
  generationInputMentions,
  scanGenerationInputTokens,
} from "./generation-input-mentions.js";

type NotebookReferenceIssueCode =
  | "not_found"
  | "ambiguous"
  | "not_media"
  | "no_output";

interface ResolvedNotebookReference {
  mention: string;
  reference: string;
  artifactId: string;
  artifactLabel?: string;
  cellId?: string;
  cellAddress?: string;
}

interface NotebookReferenceIssue {
  mention: string;
  reference: string;
  code: NotebookReferenceIssueCode;
  message: string;
}

interface UnconnectedNotebookReference
  extends ResolvedNotebookReference {
  message: string;
}

export interface NotebookPromptResolution {
  prompt: string;
  resolved: ResolvedNotebookReference[];
  unresolved: NotebookReferenceIssue[];
  unconnected: UnconnectedNotebookReference[];
}

interface CellMatch {
  document: NotebookDocument;
  cell: NotebookCell;
}

function mediaType(cell: NotebookCell): "image" | "video" | "audio" | null {
  if (
    cell.type === "image"
    || cell.type === "generate_image"
  ) return "image";
  if (
    cell.type === "audio"
    || cell.type === "extract_audio"
    || cell.type === "generate_audio"
  ) return "audio";
  if (
    cell.type === "video"
    || cell.type === "split_video"
    || cell.type === "generate_video"
    || cell.type === "concat"
    || cell.type === "splice"
  ) return "video";
  return null;
}

function artifactRecord(
  engine: Engine | undefined,
  artifactId: string,
): { artifactId: string; artifactLabel?: string } | null {
  if (!engine) return { artifactId };
  const artifact = engine.artifacts.get(artifactId);
  return artifact.ok
    ? {
        artifactId: artifact.value.artifactId,
        ...(artifact.value.label ? { artifactLabel: artifact.value.label } : {}),
      }
    : null;
}

function directArtifact(
  engine: Engine | undefined,
  reference: string,
): { artifactId: string; artifactLabel?: string } | null {
  if (!engine || !isUuidV7(reference)) return null;
  return artifactRecord(engine, reference);
}

function cellMatches(
  documents: readonly NotebookDocument[],
  reference: string,
): CellMatch[] {
  const slot = parseNotebookGridAddress(reference);
  if (slot) {
    return documents.flatMap((document) => {
      const cell = document.cells.find((candidate) =>
        candidate.slot.row === slot.row
        && candidate.slot.column === slot.column);
      return cell ? [{ document, cell }] : [];
    });
  }
  const exact = documents.flatMap((document) =>
    document.cells
      .filter((cell) => cell.id.toLowerCase() === reference)
      .map((cell) => ({ document, cell })));
  if (exact.length > 0) return exact;
  return documents.flatMap((document) =>
    document.cells
      .filter((cell) => cell.id.toLowerCase().startsWith(reference))
      .map((cell) => ({ document, cell })));
}

function issue(
  mention: string,
  reference: string,
  code: NotebookReferenceIssueCode,
  message: string,
): NotebookReferenceIssue {
  return { mention, reference, code, message };
}

export function resolveNotebookArtifactReference(input: {
  engine?: Engine;
  documents: readonly NotebookDocument[];
  reference: string;
  requireMedia?: boolean;
}): ResolvedNotebookReference | NotebookReferenceIssue {
  const reference = normalizeNotebookReference(input.reference);
  const mention = `@${reference}`;
  if (!reference) {
    return issue(mention, reference, "not_found", "Notebook reference is required");
  }
  const direct = directArtifact(input.engine, reference);
  if (direct) return { mention, reference, ...direct };
  const matches = cellMatches(input.documents, reference);
  if (matches.length === 0) {
    return issue(
      mention,
      reference,
      "not_found",
      `Notebook reference ${mention} was not found`,
    );
  }
  const mediaMatches = input.requireMedia === false
    ? matches
    : matches.filter(({ cell }) => mediaType(cell) !== null);
  if (mediaMatches.length === 0) {
    return issue(
      mention,
      reference,
      "not_media",
      `${mention} is not a media-producing cell`,
    );
  }
  const outputMatches = mediaMatches.flatMap(({ document, cell }) => {
    const artifactId = resolveNotebookCellArtifactId(document, cell);
    return typeof artifactId === "string"
      ? [{ document, cell, artifactId }]
      : [];
  });
  if (outputMatches.length === 0) {
    return issue(
      mention,
      reference,
      "no_output",
      `${mention} does not have media output yet`,
    );
  }
  const artifactIds = [...new Set(
    outputMatches.map(({ artifactId }) => artifactId),
  )];
  if (artifactIds.length > 1) {
    return issue(
      mention,
      reference,
      "ambiguous",
      `Notebook reference ${mention} is ambiguous; include notebook_id or a longer cell id`,
    );
  }
  const artifact = artifactRecord(input.engine, artifactIds[0]!);
  if (!artifact) {
    return issue(
      mention,
      reference,
      "not_found",
      `Media output for ${mention} was not found`,
    );
  }
  const match = outputMatches[0]!;
  return {
    mention,
    reference,
    ...artifact,
    cellId: match.cell.id,
    cellAddress: notebookGridTag(match.cell.slot),
  };
}

export function resolveNotebookPromptReferences(input: {
  engine?: Engine;
  document: NotebookDocument;
  prompt: string;
  connectedArtifactIds?: ReadonlySet<string>;
  requireMedia?: boolean;
}): NotebookPromptResolution {
  const resolved: ResolvedNotebookReference[] = [];
  const unresolved: NotebookReferenceIssue[] = [];
  const seen = new Set<string>();
  for (const mention of scanNotebookMentions(input.prompt)) {
    if (seen.has(mention.reference)) continue;
    seen.add(mention.reference);
    const result = resolveNotebookArtifactReference({
      engine: input.engine,
      documents: [input.document],
      reference: mention.reference,
      requireMedia: input.requireMedia,
    });
    if ("code" in result) {
      unresolved.push({ ...result, mention: mention.raw });
    } else {
      resolved.push({ ...result, mention: mention.raw });
    }
  }
  const prompt = replaceNotebookMentions(
    input.prompt,
    resolved.map((item) => ({
      reference: item.reference,
      replacement: `@${item.artifactId}`,
    })),
  );
  const unconnected = input.connectedArtifactIds
    ? resolved
        .filter((item) => !input.connectedArtifactIds!.has(item.artifactId))
        .map((item) => ({
          ...item,
          message: `${item.mention} is referenced but not connected`,
        }))
    : [];
  return { prompt, resolved, unresolved, unconnected };
}

function inputTokenResolution(
  engine: Engine | undefined,
  document: NotebookDocument,
  token: string,
  sourceCellId: string | undefined,
): ResolvedNotebookReference | NotebookReferenceIssue {
  const mention = `@${token}`;
  if (!sourceCellId) {
    return issue(mention, token, "not_found", `${mention} is not a connected input`);
  }
  const cell = document.cells.find((candidate) => candidate.id === sourceCellId);
  const artifactId = cell ? resolveNotebookCellArtifactId(document, cell) : undefined;
  if (!cell || typeof artifactId !== "string") {
    return issue(mention, token, "no_output", `${mention} does not have media output yet`);
  }
  const artifact = artifactRecord(engine, artifactId);
  if (!artifact) {
    return issue(mention, token, "not_found", `Media output for ${mention} was not found`);
  }
  return {
    mention,
    reference: token,
    ...artifact,
    cellId: cell.id,
    cellAddress: notebookGridTag(cell.slot),
  };
}

function gridAddressIssues(prompt: string): NotebookReferenceIssue[] {
  const seen = new Set<string>();
  return scanNotebookMentions(prompt).flatMap((mention) => {
    if (seen.has(mention.reference)) return [];
    seen.add(mention.reference);
    return [issue(
      mention.raw,
      mention.reference,
      "not_found",
      `${mention.raw} is a grid address; name connected inputs as @image1, @video1, @audio1`,
    )];
  });
}

/** Resolve "@image1"-style input tokens in a generation prompt to
 *  "@<artifact-id>". Grid addresses are not inputs and stay unresolved. */
export function resolveGenerationInputReferences(input: {
  engine?: Engine;
  document: NotebookDocument;
  cell: NotebookCell;
  prompt: string;
}): NotebookPromptResolution {
  const sources = new Map(
    generationInputMentions(input.cell.id, input.document.cells, input.document.edges,
      typeof input.cell.inputs?.generationMode === "string" ? input.cell.inputs.generationMode : undefined)
      .map((mention) => [mention.token, mention.sourceCellId]),
  );
  if (input.cell.inputs?.generationMode === "r2v") {
    for (const mention of generationInputMentions(
      input.cell.id, input.document.cells, input.document.edges, "i2v",
    )) {
      if (mention.token === "firstframe" || mention.token === "lastframe") {
        sources.set(mention.token, mention.sourceCellId);
      }
    }
  }
  const resolved: ResolvedNotebookReference[] = [];
  const unresolved: NotebookReferenceIssue[] = [];
  for (const token of new Set(scanGenerationInputTokens(input.prompt))) {
    const result = inputTokenResolution(
      input.engine,
      input.document,
      token,
      sources.get(token),
    );
    if ("code" in result) unresolved.push(result);
    else resolved.push(result);
  }
  const prompt = replaceNotebookMentions(
    input.prompt,
    resolved.map((item) => ({
      reference: item.reference,
      replacement: `@${item.artifactId}`,
    })),
  );
  return {
    prompt,
    resolved,
    unresolved: [...unresolved, ...gridAddressIssues(prompt)],
    unconnected: [],
  };
}

// A spoken or typed request names a cell the way the grid labels it: "the image
// at A1". Bare like that it is prose, so nothing above resolves it, the draft
// connects no inputs, and the generation prompt keeps words where an address
// belongs. Tagging closes that gap, but only for addresses this notebook can
// actually answer -- an unmatched token stays prose.
const BARE_GRID_ADDRESS = new RegExp(
  `(?<![\\w@-])(?:${NOTEBOOK_GRID_ADDRESS_SOURCE})(?![\\w-])`,
  "giu",
);

/** Addresses of cells that already hold media this notebook can reference. */
export function notebookMediaAddresses(
  document: NotebookDocument,
): ReadonlySet<string> {
  const addresses = new Set<string>();
  for (const cell of document.cells) {
    if (mediaType(cell) === null) continue;
    if (typeof resolveNotebookCellArtifactId(document, cell) !== "string") {
      continue;
    }
    addresses.add(notebookGridAddress(cell.slot));
  }
  return addresses;
}

export function tagNotebookGridAddresses(
  text: string,
  addresses: ReadonlySet<string>,
): string {
  if (addresses.size === 0) return text;
  return text.replace(BARE_GRID_ADDRESS, (match) => {
    const address = match.toLowerCase();
    return addresses.has(address) ? `@${address}` : match;
  });
}
