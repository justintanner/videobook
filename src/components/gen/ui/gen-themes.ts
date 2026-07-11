// Form-control themes for generation UI. Sourced from the canonical 5-domain
// palette in src/theme/domains.ts.

import { sectionTheme, type Domain, type SectionTheme } from '@/theme/domains';

export type { SectionTheme as GenTheme };

export const genThemes: Record<Domain, SectionTheme> = {
  projects: sectionTheme('projects'),
  image: sectionTheme('image'),
  video: sectionTheme('video'),
  notebook: sectionTheme('notebook'),
  final: sectionTheme('final'),
};
