export function grokImagine1080pImageCountError(
  imageCount: number,
  resolution: unknown,
): string | null {
  if (resolution !== "1080p" || imageCount <= 1) return null;
  return `Grok Imagine image-to-video accepts exactly 1 image at 1080p (got ${imageCount}); remove extra image inputs or choose 720p or 480p.`;
}
