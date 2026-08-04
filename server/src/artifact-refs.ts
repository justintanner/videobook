import type { ArtifactKind, Engine } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";

// Post-resolution prompts and tool args reference media as @<artifact-id>
// tokens (grid addresses are resolved to artifact ids before any tool or
// payload sees them).
const ARTIFACT_ID_TAG_PATTERN =
  /@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![\w-])/giu;

export interface ResolvedArtifactRef {
  tag: string;
  artifactId: string;
  artifactLabel?: string;
  artifactType: ArtifactKind;
  filePath: string | null;
  workspacePath: string;
}

// `@s01`-`@s99` address the primary sequence's slots by ordinal; they expand
// to the artifact id occupying that slot before any other resolution runs.
const SLOT_TAG_PATTERN = /@s(\d{1,2})(?![\w-])/giu;

export function expandSlotRefs(
  text: string,
  slotArtifactIds: readonly string[],
): string {
  return text.replace(SLOT_TAG_PATTERN, (match, ordinal: string) => {
    const artifactId = slotArtifactIds[Number(ordinal) - 1];
    return artifactId ? `@${artifactId}` : match;
  });
}

/** Bare artifact ids mentioned in the text, in first-mention order. */
export function parseArtifactIdTags(text: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(ARTIFACT_ID_TAG_PATTERN)) {
    const id = (match[1] ?? "").toLowerCase();
    if (id && !tags.includes(id)) tags.push(id);
  }
  return tags;
}

export async function resolveArtifactRefs(
  engine: Engine,
  references: readonly string[],
): Promise<{ resolved: ResolvedArtifactRef[]; unresolved: string[] }> {
  const resolved: ResolvedArtifactRef[] = [];
  const unresolved: string[] = [];
  for (const reference of references) {
    const artifactId = reference.replace(/^@/u, "").toLowerCase();
    const artifact = engine.artifacts.get(artifactId);
    if (!artifact.ok) {
      unresolved.push(`@${artifactId}`);
      continue;
    }
    const manifest = await engine.files.manifest(artifactId);
    const primary = manifest.ok
      ? findPrimaryMediaFile(manifest.value.files, artifact.value.kind)
      : null;
    resolved.push({
      tag: `@${artifactId}`,
      artifactId,
      ...(artifact.value.label ? { artifactLabel: artifact.value.label } : {}),
      artifactType: artifact.value.kind,
      filePath: primary ? primary.name : null,
      workspacePath: artifact.value.path,
    });
  }
  return { resolved, unresolved };
}
