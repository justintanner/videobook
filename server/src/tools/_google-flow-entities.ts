import type { GoogleFlowProvider } from "@apicity/googleflow";

/**
 * Tolerant readers + email resolution for the Google Flow voices/characters/
 * accounts endpoints.
 *
 * Those endpoints return `GoogleFlowResponse = Record<string, unknown>` with no
 * typed shape (docs/apicity-gaps.md §14), and useapi.net varies the envelope
 * (bare value, `{ voice }`, nested object, list under a plural key). These
 * helpers extract just the ref / display name / email we need across those
 * shapes, mirroring `readMediaGenerationId` in jobs/_google-flow.ts.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/**
 * Pull a created-entity ref out of a create response or a list item. useapi.net
 * returns the ref in the `voice` / `character` field; tolerate a nested object
 * and the generic `ref` / `id` / `entityId` keys too.
 */
export function readCreatedRef(res: Record<string, unknown>, key: "voice" | "character"): string | null {
  const direct = res[key];
  if (typeof direct === "string" && direct.trim() !== "") return direct;
  const nested = asRecord(direct);
  if (nested) {
    const inner = firstString(nested[key], nested.ref, nested.id, nested.entityId);
    if (inner) return inner;
  }
  return firstString(res.ref, res.id, res.entityId);
}

export type GoogleFlowEntity = {
  ref: string | null;
  display_name: string | null;
  /** Signed preview URL when available (character retrieve / enriched list). */
  thumbnail_url: string | null;
  /** Number of reference images a character carries (1-2); feeds the client
   *  media-strip budget meter and ×N badge. */
  image_count: number | null;
  raw: unknown;
};

/** Pull a signed character thumbnail from a retrieve (or list-item) body. */
export function readCharacterThumbnailUrl(res: Record<string, unknown>): string | null {
  const direct = firstString(res.thumbnailUrl, res.thumbnail_url);
  if (direct) return direct;
  const images = res.imageReferences ?? res.image_references;
  if (!Array.isArray(images)) return null;
  for (const img of images) {
    const rec = asRecord(img);
    if (!rec) continue;
    const url = firstString(rec.previewUrl, rec.preview_url, rec.url);
    if (url) return url;
  }
  return null;
}

function readEntityItem(item: unknown, refKey: "voice" | "character"): GoogleFlowEntity {
  const rec = asRecord(item);
  if (!rec) {
    return {
      ref: typeof item === "string" ? item : null,
      display_name: null,
      thumbnail_url: null,
      image_count: null,
      raw: item,
    };
  }
  const imageCount = readCharacterImageCount(rec);
  return {
    ref: readCreatedRef(rec, refKey),
    display_name: firstString(rec.displayName, rec.display_name, rec.name),
    thumbnail_url: refKey === "character" ? readCharacterThumbnailUrl(rec) : null,
    image_count: refKey === "character" ? imageCount : null,
    raw: item,
  };
}

/** Count of reference images a character carries, from imageReferences length
 *  (tolerant of the alias shape). Clamped to 1..2; null when absent. */
export function readCharacterImageCount(rec: Record<string, unknown>): number | null {
  const images = rec.imageReferences ?? rec.image_references;
  if (!Array.isArray(images)) return null;
  const n = images.length;
  if (!Number.isFinite(n)) return null;
  return Math.min(2, Math.max(1, Math.trunc(n)));
}

/**
 * Read a list response into entities. Prefer `res[pluralKey]`; fall back to the
 * first array-valued property (list endpoints vary in envelope shape).
 */
export function readEntityList(
  res: Record<string, unknown>,
  pluralKey: "voices" | "characters",
  refKey: "voice" | "character",
): GoogleFlowEntity[] {
  const named = res[pluralKey];
  const arr: unknown[] = Array.isArray(named)
    ? named
    : (Object.values(res).find((v) => Array.isArray(v)) as unknown[] | undefined) ?? [];
  return arr.map((item) => readEntityItem(item, refKey));
}

/**
 * Extract account emails from GET /accounts across the shapes useapi returns: an
 * `accounts` array (of strings or `{ email }` objects), a bare array, an
 * email-keyed object map, or objects carrying an `email` field. Deduped,
 * order-preserving.
 */
export function readGoogleFlowAccountEmails(res: Record<string, unknown>): string[] {
  const emails: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && v.includes("@") && !emails.includes(v)) emails.push(v);
  };
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") push(item);
        else {
          const r = asRecord(item);
          if (r) push(r.email);
        }
      }
      return;
    }
    const rec = asRecord(value);
    if (!rec) return;
    for (const [k, v] of Object.entries(rec)) {
      push(k);
      if (typeof v === "string") push(v);
      else {
        const r = asRecord(v);
        if (r) push(r.email);
      }
    }
  };
  collect(res.accounts);
  collect(res);
  return emails;
}

/**
 * Resolve the Google Flow account email the entity endpoints require. apicity
 * makes `email` mandatory on voices create/list and characters list even though
 * useapi.net defaults it to the configured account (docs/apicity-gaps.md §17).
 * An explicit value wins; otherwise use the sole configured account, and fail
 * loudly when zero or several are configured.
 */
export async function resolveGoogleFlowEmail(
  provider: GoogleFlowProvider,
  explicit?: string,
): Promise<string> {
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
  const res = await provider.get.v1.accounts({});
  const emails = readGoogleFlowAccountEmails(res as Record<string, unknown>);
  if (emails.length === 1) return emails[0];
  if (emails.length === 0) {
    throw new Error(
      "No Google Flow accounts are configured on this useapi.net token — pass `email` explicitly.",
    );
  }
  throw new Error(
    `Multiple Google Flow accounts are configured (${emails.join(", ")}) — pass \`email\` explicitly.`,
  );
}
