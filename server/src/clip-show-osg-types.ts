// Canonical visual treatments for a Clip Show on-screen graphic (OSG). Stored
// on an OSG as `treatment` and used to steer the text-to-image prompt and the
// on-screen presentation. Mirrored client-side in PlanViewer for the per-OSG
// treatment badge/dropdown (id + label only).

export type ClipShowTreatment = {
  id: string;
  label: string;
  // One-line description of the look — folded into the generation guidance.
  hint: string;
};

export const DEFAULT_TREATMENT = "photo";

export const CLIP_SHOW_TREATMENTS: ClipShowTreatment[] = [
  { id: "photo", label: "Photo", hint: "A plain documentary-style photograph." },
  { id: "cityscape", label: "Cityscape", hint: "An establishing wide/aerial shot of a place." },
  { id: "map", label: "Map", hint: "A map locating the place or region." },
  { id: "headline", label: "Headline", hint: "A real-looking news headline card or screenshot." },
  { id: "fake_poster", label: "Fake poster", hint: "A fabricated movie/ad poster as a comedic payoff." },
  { id: "title_card", label: "Title card", hint: "A bold title/button card." },
  { id: "caption", label: "Caption", hint: "A full-screen pull-quote or caption card." },
  { id: "portrait", label: "Portrait", hint: "A portrait of a person referenced in the joke." },
];

const byId = new Map(CLIP_SHOW_TREATMENTS.map((t) => [t.id, t]));

// Coerce any stored/incoming id to a known one (unknown → "photo").
export function normalizeTreatment(id: string | null | undefined): string {
  if (!id) return DEFAULT_TREATMENT;
  return byId.has(id) ? id : DEFAULT_TREATMENT;
}
