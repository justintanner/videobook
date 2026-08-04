import type {
  Engine,
  NotebookCell,
  NotebookDocument,
} from "videobook-engine";
import {
  notebookGridTag,
  parseNotebookGridAddress,
} from "videobook-engine/notebook-grid";
import {
  normalizeNotebookReference,
  replaceNotebookMentions,
  scanNotebookMentions,
} from "videobook-engine/notebook-mentions";
import { isProviderNativeMention } from "./provider-prompt-transform.js";

export type NotebookReferenceIssueCode =
  | "not_found"
  | "ambiguous"
  | "not_media"
  | "no_output";

export interface ResolvedNotebookReference {
  mention: string;
  reference: string;
  artifactId: string;
  artifactSlug: string;
  cellId?: string;
  cellSlug?: string;
  cellAddress?: string;
}

export interface NotebookReferenceIssue {
  mention: string;
  reference: string;
  code: NotebookReferenceIssueCode;
  message: string;
}

export interface UnconnectedNotebookReference
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
  if (cell.type === "image" || cell.type === "generate_image") return "image";
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
): { artifactId: string; artifactSlug: string } | null {
  if (!engine) return { artifactId, artifactSlug: artifactId };
  const artifact = engine.artifacts.get(artifactId);
  return artifact.ok
    ? {
        artifactId: artifact.value.artifactId,
        artifactSlug: artifact.value.slug,
      }
    : null;
}

function directArtifact(
  engine: Engine | undefined,
  reference: string,
): { artifactId: string; artifactSlug: string } | null {
  if (!engine) return null;
  const artifact = engine.artifacts.get(reference);
  return artifact.ok
    ? {
        artifactId: artifact.value.artifactId,
        artifactSlug: artifact.value.slug,
      }
    : null;
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
      .filter((cell) =>
        cell.slug.toLowerCase() === reference
        || cell.id.toLowerCase() === reference)
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
  const outputMatches = mediaMatches.filter(({ cell }) =>
    typeof cell.outputArtifactId === "string");
  if (outputMatches.length === 0) {
    return issue(
      mention,
      reference,
      "no_output",
      `${mention} does not have media output yet`,
    );
  }
  const artifactIds = [...new Set(
    outputMatches.map(({ cell }) => cell.outputArtifactId!),
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
    cellSlug: match.cell.slug,
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
    if (seen.has(mention.reference) || isProviderNativeMention(mention.raw)) {
      continue;
    }
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
      replacement: `@${item.artifactSlug}`,
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
