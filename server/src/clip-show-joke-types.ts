// Canonical comedic styles a Clip Show host can use for a joke. Stored on a
// segment as `joke_type` and used to steer GPT-5.5 when (re)generating that
// joke. The "auto" type carries no steering — it's the model's free choice and
// the default for freshly generated plans. Mirrored client-side in PlanViewer
// for the per-joke dropdown (id + label only).

export type ClipShowJokeType = {
  id: string;
  label: string;
  // Extra instruction appended to the item's prompt. Empty for "auto".
  hint: string;
};

export const DEFAULT_JOKE_TYPE = "auto";

export const CLIP_SHOW_JOKE_TYPES: ClipShowJokeType[] = [
  { id: "auto", label: "Auto", hint: "" },
  { id: "observational", label: "Observational", hint: "Make it a wry, true-to-life observation about what's literally there." },
  { id: "one_liner", label: "One-liner", hint: "Make it a single tight quip — one clean setup and one punch." },
  { id: "pun", label: "Pun / wordplay", hint: "Lean on a pun, double meaning, or wordplay." },
  { id: "deadpan", label: "Deadpan", hint: "Keep it flat, dry, and understated — state the absurd thing plainly." },
  { id: "absurdist", label: "Absurdist", hint: "Go surreal with escalating, non-sequitur logic." },
  { id: "roast", label: "Roast", hint: "Make it a playful roast that punches at the situation, never at protected traits." },
  { id: "self_deprecating", label: "Self-deprecating", hint: "Have the host turn the joke on themselves." },
  { id: "hyperbole", label: "Hyperbole", hint: "Push it to wild, ridiculous exaggeration." },
];

const byId = new Map(CLIP_SHOW_JOKE_TYPES.map((t) => [t.id, t]));

// Coerce any stored/incoming id to a known one (unknown → "auto").
export function normalizeJokeType(id: string | null | undefined): string {
  if (!id) return DEFAULT_JOKE_TYPE;
  return byId.has(id) ? id : DEFAULT_JOKE_TYPE;
}

// Steering text for an item's prompt; "" when the type is "auto" or unknown.
export function jokeTypeHint(id: string | null | undefined): string {
  return byId.get(normalizeJokeType(id))?.hint ?? "";
}
