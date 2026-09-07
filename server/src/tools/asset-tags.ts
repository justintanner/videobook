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
import { TAG_FACETS } from "videobook-engine";
import { z } from "zod";
import { assetTagSummary } from "../asset-tags.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const facetSchema = z.enum(TAG_FACETS).describe(
  "Tag facet: people, places and editing are the automatic vocabulary; custom holds free-form user tags",
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
        facet: facetSchema,
        label: labelSchema,
        entity_id: z.string().optional().describe(
          "An already-confirmed entity to reference; never invent one",
        ),
      },
      handler: async (args) => {
        const { asset_id, facet, label, entity_id } = args as {
          asset_id: string;
          facet: TagFacet;
          label: string;
          entity_id?: string;
        };
        try {
          const artifact = resolveArtifact(engine, asset_id);
          const result = await engine.tags.add(artifact.artifactId, {
            facet,
            label,
            ...(entity_id ? { entityId: entity_id } : {}),
          });
          if (!result.ok) return failure(new Error(result.error.message));
          return json({
            asset_id: artifact.artifactId,
            tags: assetTagSummary(result.value),
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
        facet: facetSchema,
        label: labelSchema,
      },
      handler: async (args) => {
        const { asset_id, facet, label } = args as {
          asset_id: string;
          facet: TagFacet;
          label: string;
        };
        try {
          const artifact = resolveArtifact(engine, asset_id);
          const result = await engine.tags.remove(artifact.artifactId, {
            facet,
            label,
          });
          if (!result.ok) return failure(new Error(result.error.message));
          return json({
            asset_id: artifact.artifactId,
            tags: assetTagSummary(result.value),
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
        facet: facetSchema,
        label: labelSchema,
      },
      handler: async (args) => {
        const { asset_id, facet, label } = args as {
          asset_id: string;
          facet: TagFacet;
          label: string;
        };
        try {
          const artifact = resolveArtifact(engine, asset_id);
          const result = await engine.tags.restore(artifact.artifactId, {
            facet,
            label,
          });
          if (!result.ok) return failure(new Error(result.error.message));
          return json({
            asset_id: artifact.artifactId,
            tags: assetTagSummary(result.value),
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
          const suggestions = engine.tags.suggest({
            ...(prefix !== undefined ? { prefix } : {}),
            ...(facet ? { facet } : {}),
            ...(kinds ? { kinds } : {}),
            ...(limit ? { limit } : {}),
          });
          if (!suggestions.ok) {
            return failure(new Error(suggestions.error.message));
          }
          const asset = asset_id
            ? tagState(engine, resolveArtifact(engine, asset_id).artifactId)
            : null;
          return json({
            facets: TAG_FACETS,
            suggestions: suggestions.value.map((row) => ({
              facet: row.facet,
              key: row.key,
              label: row.label,
              assets: row.artifacts,
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
