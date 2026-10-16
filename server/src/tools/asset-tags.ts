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

type TagEditOp = "add" | "remove" | "restore";

type TagEdit = { asset_id: string; op: TagEditOp; facet?: TagFacet; label: string; entity_id?: string };

async function applyToIdentities(
  engine: Engine,
  assetId: string,
  identities: ReadonlyArray<{ facet: TagFacet; label: string }>,
  op: "remove" | "restore",
): Promise<void> {
  for (const identity of identities) {
    const result = op === "remove"
      ? await engine.tags.remove(assetId, identity)
      : await engine.tags.restore(assetId, identity);
    if (!result.ok) throw new Error(result.error.message);
  }
}

async function editAssetTag(engine: Engine, edit: TagEdit): Promise<ToolResult> {
  if (edit.entity_id && edit.op !== "add") throw new Error("entity_id applies only to op add");
  const artifact = resolveArtifact(engine, edit.asset_id);
  const assetId = artifact.artifactId;
  const { tag, identities } = matchingIdentities(engine, assetId, edit);
  if (edit.op === "add") {
    const added = await engine.tags.add(assetId, { ...tag, ...(edit.entity_id ? { entityId: edit.entity_id } : {}) });
    if (!added.ok) throw new Error(added.error.message);
  }
  await applyToIdentities(engine, assetId, identities, edit.op === "remove" ? "remove" : "restore");
  return json({ asset_id: assetId, tags: tagState(engine, assetId) });
}

export function assetTagDefs(engine: Engine): ToolDef[] {
  return [
    {
      name: "edit_asset_tag",
      description:
        "Add, remove or restore one tag on an asset. add makes a manual tag that survives re-analysis; removing an automatic tag records a dismissal so re-analysis cannot bring it back; restore clears that dismissal.",
      annotations: { idempotentHint: true },
      schema: {
        book_id: z.string().describe("Book that owns the asset"),
        asset_id: z.string().describe("Artifact id to edit"),
        op: z.enum(["add", "remove", "restore"]),
        facet: facetSchema.optional(),
        label: labelSchema,
        entity_id: z.string().optional().describe(
          "With op add: an already-confirmed entity to reference; never invent one",
        ),
      },
      handler: async (args) => {
        try {
          return await editAssetTag(engine, args as TagEdit);
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
