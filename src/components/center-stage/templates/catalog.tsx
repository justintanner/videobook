import { Images, MapPin, Mic, type LucideIcon } from 'lucide-react';
import type { PlanFormula } from '../PlanViewer';

// Client-side template catalog for the /templates marketplace. The set of plan
// formulas is small and hardcoded server-side, so this stays in the client; add
// an entry here to surface a new template card + preview.
export interface TemplateCatalogEntry {
  id: PlanFormula;
  name: string;
  tagline: string;
  description: string;
  produces: string;
  inputs: string[];
  // Icon component so each surface (card vs preview hero) can size it.
  icon: LucideIcon;
  keywords: string[];
  legacy?: boolean;
}

export const TEMPLATE_CATALOG: TemplateCatalogEntry[] = [
  {
    id: 'clip_show',
    name: 'Clip Show',
    tagline: 'A voiced host riffs on your clips.',
    description:
      'A host character introduces and reacts to a sequence of video clips. GPT writes the jokes, dialog, and per-segment prompts; ElevenLabs voices the host; each segment gets a first frame and a generated video.',
    produces: 'A multi-segment show — host dialog → voiceover audio → first frame → video, per clip.',
    inputs: ['1 host character (char-*) with an ElevenLabs voice', '1–8 video clips (vid-*)', 'Optional topic + host tone'],
    icon: Mic,
    keywords: ['clip', 'show', 'host', 'commentary', 'reaction', 'voice', 'talking', 'podcast'],
  },
  {
    id: 'storyboard_video',
    name: 'Storyboard',
    tagline: 'Turn source images into a storyboard, then a video.',
    description:
      'From one or more source images, build a 16:9 storyboard frame with GPT Image, then animate it into a short 720p video with Seedance.',
    produces: 'A 2K storyboard image and a 720p video generated from it.',
    inputs: ['1+ source images (img-*)', 'Optional storyboard brief', 'Duration + video model'],
    icon: Images,
    keywords: ['storyboard', 'image', 'animate', 'seedance', 'video', 'still', 'gpt image'],
  },
  {
    id: 'char_swap',
    name: 'Char Swap',
    tagline: 'Swap two on-screen subjects across a video.',
    description:
      'Split a transcribed video into shot-aligned scenes and remix each one, replacing the two on-screen subjects with your character references via gpt-image + Seedance.',
    produces: 'A per-scene plan with first/last-frame swaps and a regenerated video per scene.',
    inputs: ['1 processed video (vid-*) with word-level timings', 'Exactly 2 character or image references'],
    icon: MapPin,
    keywords: ['char', 'swap', 'character', 'replace', 'face', 'visualization', 'remix', 'legacy'],
    legacy: true,
  },
];

export function searchTemplates(query: string): TemplateCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return TEMPLATE_CATALOG;
  const terms = q.split(/\s+/);
  return TEMPLATE_CATALOG.filter((t) => {
    const haystack = [t.name, t.tagline, t.description, ...t.keywords].join(' ').toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
