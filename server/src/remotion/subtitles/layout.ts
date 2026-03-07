import type { Word } from "./types.js";

export interface WordLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  lineIndex: number;
}

export interface LayoutResult {
  layouts: WordLayout[];
  totalHeight: number;
  lines: WordLayout[][];
}

export function layoutWords(
  words: Word[],
  canvasWidth: number,
  fontSizePx: number,
  margin = 80,
): LayoutResult {
  const availableWidth = canvasWidth - 2 * margin;
  const charWidth = fontSizePx * 0.65;
  const spaceWidth = fontSizePx * 0.3;
  const lineHeight = fontSizePx * 1.2;
  const lineSpacing = fontSizePx * 0.35;

  const wordTexts = words.map((w) => w.word.trim().toUpperCase());
  const wordWidths = wordTexts.map((t) => t.length * charWidth);

  const lines: number[][] = [];
  let currentLine: number[] = [];
  let currentLineWidth = 0;

  for (let i = 0; i < wordTexts.length; i++) {
    const w = wordWidths[i];
    const testWidth = currentLineWidth + (currentLineWidth > 0 ? spaceWidth : 0) + w;

    if (currentLine.length > 0 && testWidth > availableWidth) {
      lines.push(currentLine);
      currentLine = [i];
      currentLineWidth = w;
    } else {
      currentLine.push(i);
      currentLineWidth = testWidth;
    }
  }
  if (currentLine.length > 0) lines.push(currentLine);

  const layouts: WordLayout[] = new Array(words.length);
  const layoutLines: WordLayout[][] = [];
  let yOffset = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineIndices = lines[lineIdx];
    let lineWidth = 0;
    for (const i of lineIndices) {
      if (wordTexts[i]) {
        lineWidth += wordWidths[i] + (lineWidth > 0 ? spaceWidth : 0);
      }
    }

    const lineX = Math.round((canvasWidth - lineWidth) / 2);
    let x = lineX;
    const lineLayouts: WordLayout[] = [];

    for (const i of lineIndices) {
      const layout: WordLayout = {
        x,
        y: yOffset,
        width: Math.round(wordWidths[i]),
        height: Math.round(lineHeight),
        text: wordTexts[i],
        lineIndex: lineIdx,
      };
      layouts[i] = layout;
      lineLayouts.push(layout);
      x += Math.round(wordWidths[i] + spaceWidth);
    }

    layoutLines.push(lineLayouts);
    yOffset += Math.round(lineHeight + lineSpacing);
  }

  const totalHeight = yOffset > 0 ? yOffset - Math.round(lineSpacing) : Math.round(lineHeight);

  return { layouts, totalHeight, lines: layoutLines };
}
