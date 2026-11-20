export const SEGMENT_LOOK_IDS = ["none", "crash", "invert", "rgb_split"] as const;

export type SegmentLook = typeof SEGMENT_LOOK_IDS[number];

export interface SegmentLookInfo {
  id: SegmentLook;
  name: string;
  description: string;
}

export const SEGMENT_LOOKS: readonly SegmentLookInfo[] = [
  {
    id: "none",
    name: "None",
    description: "Keep the source colour untouched.",
  },
  {
    id: "crash",
    name: "Crash",
    description: "Two-colour cycling hues that preserve brightness.",
  },
  {
    id: "invert",
    name: "Invert",
    description: "Flip light and dark tones to their negative.",
  },
  {
    id: "rgb_split",
    name: "RGB split",
    description: "Shift red and blue channels apart horizontally.",
  },
];

const CRASH_LOOK_FILTER =
  "format=yuv444p,pseudocolor=c0='val':c1='128+(val-128)*0.6':c2='128-(val-128)*0.6',hue=H='2*PI*(0.15+0.9*t)':s=1.25";

export function lookFilter(look: SegmentLook, width: number): string | null {
  if (look === "none") return null;
  if (look === "crash") return CRASH_LOOK_FILTER;
  if (look === "invert") return "negate";
  const shift = Math.round(width * 0.012);
  return `rgbashift=rh=-${shift}:bh=${shift}`;
}
