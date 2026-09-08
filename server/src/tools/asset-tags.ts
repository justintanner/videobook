/**
 * Manual tag editing and tag discovery over MCP.
 *
 * Every operation is book-scoped: the handler runs against the engine bound
 * to `book_id`, so a Library edit made from another book still lands in the
 * book that owns the asset. Manual intent is all these tools can express —
 * the automatic set belongs to the tagging jobs, and nothing here can add to
 * it, relabel it, or clear a dismissal that a user meant to keep.
 */

import type { Engine, TagFacet } from "videobook-engine";
import { TAG_FACETS, tagCanonicalKey } from "videobook-engine";
import { z } from "zod";
import { assetTagSummary, readAssetTagSummaries, tagFacetCounts } from "../asset-tags.js";
import { matchesTagPrefix, resolveTagInput } from "../tag-vocabulary.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const facetSchema = z.enum(TAG_FACETS).describe(
  "Optional category; inferred from the label when omitted. Use custom for a free-form tag with a separate identity",
);

const labelSchema = z.string().min(1).describe(
  "Display label; the engine normalizes it into the canonical identity",
);

/** One tag filter term: a label, optionally pinned to a single facet. */
export const tagSelectorSchema = z.object({
  facet: facetSchema.optional(),
  label: labelSchema,
});

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(cause: unknown): ToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: cause instanceof Error ? cause.message : String(cause),
    }],
  };
}

/**
 * Tag operations address artifacts, and the Library also lists synthetic
 * notebook rows whose id is a notebook id. Resolving through the artifact
 * catalog first turns that into a clear error instead of a foreign-key
 * failure from the write.
 */
function resolveArtifact(engine: Engine, assetId: string) {
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) throw new Error(artifact.error.message);
  return artifact.value;
}

function tagState(engine: Engine, assetId: string) {
  const state = engine.tags.read(assetId);
  if (!state.ok) throw new Error(state.error.message);
  return assetTagSummary(state.value);
}

function matchingIdentities(engine: Engine, assetId: string, input: { facet?: TagFacet; label: string }) {
  const state = engine.tags.read(assetId);
  if (!state.ok) throw new Error(state.error.message);
  const existing = [...state.value.manual, ...state.value.automatic, ...state.value.dismissed];
  const tag = resolveTagInput(input, existing);
  const key = tagCanonicalKey(tag.label);
  const aliases = existing.filter((entry) => entry.facet === tag.facet
    && tagCanonicalKey(resolveTagInput(entry).label) === key);
  const identities = [...new Map([tag, ...aliases].map((entry) =>
    [`${entry.facet}/${tagCanonicalKey(entry.label)}`, { facet: entry.facet, label: entry.label }])).values()];
  return { tag, identities };
}

export function assetTagDefs(engine: Engine): ToolDef[] {
  return [
    {
      name: "add_asset_tag",
      description:
        "Add a manual tag to one asset. Manual tags survive re-analysis and cannot be replaced by automatic tagging.",
      annotations: { idempotentHint: true },
      schema: {
        book_id: z.string().describe("Book that owns the asset"),
        asset_id: z.string().describe("Artifact id to tag"),
        facet: facetSchema.optional(),
        label: labelSchema,
        entity_id: z.string().optional().describe(
          "An already-confirmed entity to reference; never invent one",
        ),
      },
      handler: async (args) => {
        const { asset_id, facet, label, entity_id } = args as {
          asset_id: string;
          facet?: TagFacet;
          label: string;
          entity_id?: string;
        };
        try {
          const artifact = resolveArtifact(engine, asset_id);
          const { tag, identities } = matchingIdentities(engine, asset_id, { facet, label });
          const result = await engine.tags.add(artifact.artifactId, {
            ...tag,
            ...(entity_id ? { entityId: entity_id } : {}),
          });
          if (!result.ok) return failure(new Error(result.error.message));
          for (const identity of identities) {
            const restored = await engine.tags.restore(asset_id, identity);
            if (!restored.ok) return failure(new Error(restored.error.message));
          }
          return json({
            asset_id: artifact.artifactId,
            tags: tagState(engine, asset_id),
          });
        } catch (cause) {
          return failure(cause);
        }
      },
    },
    {
      name: "remove_asset_tag",
      description:
        "Remove a tag from one asset. Removing an automatic tag records a dismissal, so re-analysis cannot bring it back.",
      annotations: { idempotentHint: true },
      schema: {
        book_id: z.string().describe("Book that owns the asset"),
        asset_id: z.string().describe("Artifact id to edit"),
        facet: facetSchema.optional(),
        label: labelSchema,
      },
      handler: async (args) => {
        const { asset_id, facet, label } = args as {
          asset_id: string;
          facet?: TagFacet;
          label: string;
        };
        try {
          const artifact = resolveArtifact(engine, asset_id);
          const { identities } = matchingIdentities(engine, asset_id, { facet, label });
          for (const identity of identities) {
            const result = await engine.tags.remove(asset_id, identity);
            if (!result.ok) return failure(new Error(result.error.message));
          }
          return json({
            asset_id: artifact.artifactId,
            tags: tagState(engine, asset_id),
          });
        } catch (cause) {
          return failure(cause);
        }
      },
    },
    {
      name: "restore_asset_tag",
      description:
        "Restore a dismissed automatic tag so future analysis may surface it again.",
      annotations: { idempotentHint: true },
      schema: {
        book_id: z.string().describe("Book that owns the asset"),
        asset_id: z.string().describe("Artifact id to edit"),
        facet: facetSchema.optional(),
        label: labelSchema,
      },
      handler: async (args) => {
        const { asset_id, facet, label } = args as {
          asset_id: string;
          facet?: TagFacet;
          label: string;
        };
        try {
          const artifact = resolveArtifact(engine, asset_id);
          const { identities } = matchingIdentities(engine, asset_id, { facet, label });
          for (const identity of identities) {
            const result = await engine.tags.restore(asset_id, identity);
            if (!result.ok) return failure(new Error(result.error.message));
          }
          return json({
            asset_id: artifact.artifactId,
            tags: tagState(engine, asset_id),
          });
        } catch (cause) {
          return failure(cause);
        }
      },
    },
    {
      name: "suggest_asset_tags",
      description:
        "List the tags in use in a book with the number of assets carrying each, optionally narrowed by prefix or facet. Use it for autocomplete and to discover the groups available for filtering.",
      annotations: { readOnlyHint: true },
      schema: {
        book_id: z.string().describe("Book to inspect"),
        prefix: z.string().optional().describe(
          "Match tags starting with this text; omit for the most used tags",
        ),
        facet: facetSchema.optional(),
        kinds: z.array(z.enum(["audio", "image", "video", "final"])).optional()
          .describe("Restrict counting to these artifact kinds"),
        limit: z.number().int().positive().max(200).optional(),
        asset_id: z.string().optional().describe(
          "Return this asset's own tag state alongside the suggestions",
        ),
      },
      handler: async (args) => {
        const { prefix, facet, kinds, limit, asset_id } = args as {
          prefix?: string;
          facet?: TagFacet;
          kinds?: Array<"audio" | "image" | "video" | "final">;
          limit?: number;
          asset_id?: string;
        };
        try {
          const ids = engine.artifacts.list().filter((artifact) => !kinds
            || kinds.some((kind) => kind === artifact.kind)).map((artifact) => artifact.artifactId);
          const summaries = [...readAssetTagSummaries(engine, ids).values()];
          const suggestions = tagFacetCounts(summaries.map((tags) => ({ tags })), Infinity)
            .filter((tag) => (!facet || tag.facet === facet) && matchesTagPrefix(tag, prefix ?? ""))
            .slice(0, limit ?? 50);
          const asset = asset_id
            ? tagState(engine, resolveArtifact(engine, asset_id).artifactId)
            : null;
          return json({
            facets: TAG_FACETS,
            suggestions: suggestions.map((row) => ({
              facet: row.facet,
              key: row.key,
              label: row.label,
              assets: row.assets,
            })),
            ...(asset ? { asset_id, tags: asset } : {}),
          });
        } catch (cause) {
          return failure(cause);
        }
      },
    },
  ];
}
