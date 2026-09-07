/**
 * Asset tag projection: the one place that turns engine tag state into the
 * snake_case records MCP payloads carry, and the one place that decides
 * whether an asset matches a tag filter.
 *
 * The engine owns storage, normalization and provenance; this module owns
 * presentation and the exact-match filter the Library and list_assets share,
 * so a tag reads the same way in an asset payload, a search result and a
 * filter argument.
 */

import { createHash } from "node:crypto";
import type {
  ArtifactTagState,
  AssetTag,
  AutomaticAssetTag,
  DismissedTag,
  Engine,
  TagFacet,
} from "videobook-engine";
import {
  TAG_FACETS,
  TAG_READ_BATCH_MAX,
  isTagFacet,
  normalizeTagIdentity,
  tagCanonicalKey,
} from "videobook-engine";

export type AssetTagRecord = {
  facet: TagFacet;
  /** Canonical identity within the facet; never derived from the label. */
  key: string;
  label: string;
  origin: "manual" | "automatic";
  entity_id: string | null;
};

export type DismissedTagRecord = {
  facet: TagFacet;
  key: string;
  label: string;
};

export type AssetTagAnalysis = {
  source_hash: string;
  generator: string;
  model: string | null;
  extractor_version: string;
  tag_count: number;
  generation: number;
  analyzed_at: number;
  /** The analyzed bytes are no longer among the artifact's files. */
  stale: boolean;
};

export type AssetTagSummary = {
  /** Manual tags plus live, undismissed automatic tags. */
  effective: AssetTagRecord[];
  manual: AssetTagRecord[];
  automatic: AssetTagRecord[];
  dismissed: DismissedTagRecord[];
  analysis: AssetTagAnalysis | null;
  /**
   * Changes whenever the effective set or a dismissal changes, so a refresh
   * notices a tag edit that moved no media URL and no object hash.
   */
  fingerprint: string;
};

/** A filter term: a label, optionally pinned to one facet. */
export type TagSelector = {
  facet?: TagFacet;
  label: string;
};

export type AssetTagFilter = {
  /** The asset must carry every term. */
  all?: TagSelector[];
  /** The asset must carry at least one term. */
  any?: TagSelector[];
};

type NormalizedSelector = {
  facet: TagFacet | null;
  key: string;
};

export const EMPTY_TAG_SUMMARY: AssetTagSummary = Object.freeze({
  effective: [],
  manual: [],
  automatic: [],
  dismissed: [],
  analysis: null,
  fingerprint: "",
});

function tagRecord(tag: AssetTag): AssetTagRecord {
  return {
    facet: tag.facet,
    key: tag.key,
    label: tag.label,
    origin: tag.origin,
    entity_id: tag.entityId ?? null,
  };
}

function dismissedRecord(tag: DismissedTag): DismissedTagRecord {
  return { facet: tag.facet, key: tag.key, label: tag.label };
}

function automaticRecord(tag: AutomaticAssetTag): AssetTagRecord {
  return tagRecord(tag);
}

/**
 * Identity-only digest: labels and timestamps are display detail, so a
 * re-analysis that returns the same identities leaves the fingerprint alone
 * and the client skips a needless asset refresh.
 */
function tagFingerprint(state: ArtifactTagState): string {
  const parts = [
    ...state.effective.map((tag) => `e:${tag.facet}/${tag.key}/${tag.origin}`),
    ...state.dismissed.map((tag) => `d:${tag.facet}/${tag.key}`),
  ].sort();
  if (parts.length === 0) return "";
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

export function assetTagSummary(state: ArtifactTagState): AssetTagSummary {
  return {
    effective: state.effective.map(tagRecord),
    manual: state.manual.map(tagRecord),
    automatic: state.automatic.map(automaticRecord),
    dismissed: state.dismissed.map(dismissedRecord),
    analysis: state.snapshot
      ? {
        source_hash: state.snapshot.sourceHash,
        generator: state.snapshot.generator,
        model: state.snapshot.model ?? null,
        extractor_version: state.snapshot.extractorVersion,
        tag_count: state.snapshot.tagCount,
        generation: state.snapshot.generation,
        analyzed_at: state.snapshot.analyzedAt,
        stale: state.snapshot.stale,
      }
      : null,
    fingerprint: tagFingerprint(state),
  };
}

/**
 * Batched tag read for a list of artifacts. Reads are chunked to the engine's
 * documented batch ceiling, and an artifact the engine cannot read (a
 * synthetic notebook row, say) simply has no entry.
 */
export function readAssetTagSummaries(
  engine: Engine,
  artifactIds: readonly string[],
): Map<string, AssetTagSummary> {
  const summaries = new Map<string, AssetTagSummary>();
  for (let start = 0; start < artifactIds.length; start += TAG_READ_BATCH_MAX) {
    const batch = artifactIds.slice(start, start + TAG_READ_BATCH_MAX);
    const result = engine.tags.readMany(batch);
    if (!result.ok) continue;
    for (const state of result.value) {
      summaries.set(state.artifactId, assetTagSummary(state));
    }
  }
  return summaries;
}

/**
 * Parses one filter term. A bare label matches the identity in any facet,
 * which is what a user typing "kitchen" into a filter box means; a
 * facet-qualified term keeps `people/handheld` and `editing/handheld` apart.
 */
export function normalizeSelector(selector: TagSelector): NormalizedSelector {
  if (selector.facet !== undefined) {
    if (!isTagFacet(selector.facet)) {
      throw new Error(
        `Unknown tag facet "${selector.facet}"; expected one of ${TAG_FACETS.join(", ")}`,
      );
    }
    const identity = normalizeTagIdentity({
      facet: selector.facet,
      label: selector.label,
    });
    return { facet: identity.facet, key: identity.key };
  }
  const key = tagCanonicalKey(selector.label);
  if (!key) throw new Error("Tag label is required");
  return { facet: null, key };
}

function matchesSelector(
  tags: readonly AssetTagRecord[],
  selector: NormalizedSelector,
): boolean {
  return tags.some((tag) =>
    tag.key === selector.key
    && (selector.facet === null || tag.facet === selector.facet));
}

/** True when no term was supplied — an absent filter matches everything. */
export function isEmptyTagFilter(filter: AssetTagFilter | undefined): boolean {
  return !filter
    || ((filter.all?.length ?? 0) === 0 && (filter.any?.length ?? 0) === 0);
}

/**
 * Exact identity matching against the effective set only: a dismissed tag
 * must not match, and neither may a transcript that merely mentions the word
 * — that is what semantic search is for.
 */
export function matchesTagFilter(
  summary: AssetTagSummary | undefined,
  filter: AssetTagFilter | undefined,
): boolean {
  if (isEmptyTagFilter(filter)) return true;
  const tags = summary?.effective ?? [];
  const all = (filter?.all ?? []).map(normalizeSelector);
  const any = (filter?.any ?? []).map(normalizeSelector);
  if (!all.every((selector) => matchesSelector(tags, selector))) return false;
  if (any.length > 0 && !any.some((selector) => matchesSelector(tags, selector))) {
    return false;
  }
  return true;
}

export type TagFacetCountRecord = {
  facet: TagFacet;
  key: string;
  label: string;
  /** Distinct assets carrying the identity, never assignment rows. */
  assets: number;
};

/**
 * Facet counts over an already-filtered result set, so a caller can offer the
 * groups that actually narrow what it is looking at rather than every tag in
 * the book.
 */
export function tagFacetCounts(
  assets: ReadonlyArray<{ tags: AssetTagSummary | null }>,
  limit = 50,
): TagFacetCountRecord[] {
  const counts = new Map<string, TagFacetCountRecord>();
  for (const asset of assets) {
    const seen = new Set<string>();
    for (const tag of asset.tags?.effective ?? []) {
      const identity = `${tag.facet}/${tag.key}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const existing = counts.get(identity);
      if (existing) {
        existing.assets += 1;
        continue;
      }
      counts.set(identity, {
        facet: tag.facet,
        key: tag.key,
        label: tag.label,
        assets: 1,
      });
    }
  }
  return [...counts.values()]
    .sort((left, right) =>
      right.assets - left.assets
      || left.facet.localeCompare(right.facet)
      || left.key.localeCompare(right.key))
    .slice(0, limit);
}

export type TagTransferSummary = {
  imported_manual: number;
  imported_dismissals: number;
  imported_automatic: number;
  /**
   * The source carried automatic evidence the destination cannot hold,
   * because it does not have the bytes that were analyzed. Derived content
   * therefore starts without automatic tags instead of inheriting claims
   * about media it does not contain.
   */
  skipped_automatic: boolean;
};

export const EMPTY_TRANSFER_SUMMARY: TagTransferSummary = {
  imported_manual: 0,
  imported_dismissals: 0,
  imported_automatic: 0,
  skipped_automatic: false,
};

/**
 * Moves one artifact's tag state onto a copy, in either the same engine or
 * another book's. The engine re-normalizes every label into destination-local
 * identities and validates automatic evidence against the destination's own
 * files, so this never hand-copies rows. Copying nothing is not a write: an
 * untagged source leaves the destination catalog untouched.
 */
export async function transferAssetTags(
  source: { engine: Engine; artifactId: string },
  destination: { engine: Engine; artifactId: string },
): Promise<TagTransferSummary> {
  const exported = source.engine.tags.export(source.artifactId);
  if (!exported.ok) throw new Error(exported.error.message);
  const snapshot = exported.value;
  const empty = snapshot.manual.length === 0
    && snapshot.dismissed.length === 0
    && snapshot.automatic === undefined;
  if (empty) return EMPTY_TRANSFER_SUMMARY;
  const imported = await destination.engine.tags.import(
    destination.artifactId,
    snapshot,
  );
  if (!imported.ok) throw new Error(imported.error.message);
  return {
    imported_manual: imported.value.importedManual,
    imported_dismissals: imported.value.importedDismissals,
    imported_automatic: imported.value.importedAutomatic,
    skipped_automatic: imported.value.skippedAutomatic,
  };
}

/**
 * The effective tag labels as one indexable string. Search indexing consumes
 * this rather than the raw analysis sidecar, so a dismissed tag stays out of
 * the lexical index even while the description that mentioned it remains
 * searchable as evidence.
 */
export function effectiveTagText(engine: Engine, artifactId: string): string {
  const state = engine.tags.read(artifactId);
  if (!state.ok) return "";
  return state.value.effective.map((tag) => tag.label).join(" ");
}
