export type AspectRatio = "16:9" | "9:16" | "1:1";

export type SplitLayout = {
  width: number;
  height: number;
  frameRect: { x: number; y: number; w: number; h: number };
  panelRect: { x: number; y: number; w: number; h: number };
  splitAxis: "horizontal" | "vertical";
};

export type CardPlacement = {
  x: number;
  y: number;
  w: number;
  h: number;
  index: number;
};

export type ImpactTiming = {
  frame: number;
  cardIndex: number;
};

export type OutroSpec = {
  layout: SplitLayout;
  cards: CardPlacement[];
  impacts: ImpactTiming[];
  totalDurationFrames: number;
  totalDurationSeconds: number;
  fps: number;
};

export type CueWindow = {
  startFrame: number;
  endFrame: number;
  impactIndex: number;
};

const FPS = 30;
const IMPACT_INTERVAL_S = 0.4;
const IMPACT_INTERVAL_FRAMES = Math.round(IMPACT_INTERVAL_S * FPS);
const FIRST_IMPACT_S = 0.4;
const FIRST_IMPACT_FRAME = Math.round(FIRST_IMPACT_S * FPS);
const MIN_DURATION_S = 3.0;
const TAIL_AFTER_LAST_IMPACT_S = 1.6;
const ENTRY_FRAMES = 6;
const MAX_FINAL_CUE_S = 0.6;

const PANEL_BG = "#0A0A0A";
const CARD_PAD = 24;
const CARD_GAP = 16;
const CARD_SHADOW = "0 2px 8px rgba(0,0,0,0.4)";
const CARD_RADIUS = 12;

export {
  FPS,
  IMPACT_INTERVAL_S,
  IMPACT_INTERVAL_FRAMES,
  FIRST_IMPACT_S,
  FIRST_IMPACT_FRAME,
  MIN_DURATION_S,
  TAIL_AFTER_LAST_IMPACT_S,
  ENTRY_FRAMES,
  MAX_FINAL_CUE_S,
  PANEL_BG,
  CARD_PAD,
  CARD_GAP,
  CARD_SHADOW,
  CARD_RADIUS,
};

export function splitLayout(ratio: AspectRatio): SplitLayout {
  switch (ratio) {
    case "16:9": {
      const w = 1920;
      const h = 1080;
      const half = Math.floor(w / 2);
      return {
        width: w,
        height: h,
        frameRect: { x: 0, y: 0, w: half, h },
        panelRect: { x: half, y: 0, w: w - half, h },
        splitAxis: "horizontal",
      };
    }
    case "9:16": {
      const w = 1080;
      const h = 1920;
      const half = Math.floor(h / 2);
      return {
        width: w,
        height: h,
        frameRect: { x: 0, y: 0, w, h: half },
        panelRect: { x: 0, y: half, w, h: h - half },
        splitAxis: "vertical",
      };
    }
    case "1:1": {
      const w = 1080;
      const h = 1080;
      const half = Math.floor(w / 2);
      return {
        width: w,
        height: h,
        frameRect: { x: 0, y: 0, w: half, h },
        panelRect: { x: half, y: 0, w: w - half, h },
        splitAxis: "horizontal",
      };
    }
  }
}

export function cardPlacements(
  qrCount: number,
  panelRect: { x: number; y: number; w: number; h: number },
  splitAxis: "horizontal" | "vertical",
): CardPlacement[] {
  if (qrCount < 1 || qrCount > 4) {
    throw new Error(`qrCount must be 1-4, got ${qrCount}`);
  }

  const insetX = panelRect.x + CARD_PAD;
  const insetY = panelRect.y + CARD_PAD;
  const availW = panelRect.w - CARD_PAD * 2;
  const availH = panelRect.h - CARD_PAD * 2;

  if (qrCount === 1) {
    const side = Math.min(availW, availH);
    return [{
      x: insetX + Math.floor((availW - side) / 2),
      y: insetY + Math.floor((availH - side) / 2),
      w: side,
      h: side,
      index: 0,
    }];
  }

  if (qrCount === 2) {
    if (splitAxis === "horizontal") {
      const cardH = Math.floor((availH - CARD_GAP) / 2);
      const side = Math.min(availW, cardH);
      const cx = insetX + Math.floor((availW - side) / 2);
      return [
        { x: cx, y: insetY + Math.floor((cardH - side) / 2), w: side, h: side, index: 0 },
        { x: cx, y: insetY + cardH + CARD_GAP + Math.floor((cardH - side) / 2), w: side, h: side, index: 1 },
      ];
    } else {
      const cardW = Math.floor((availW - CARD_GAP) / 2);
      const side = Math.min(cardW, availH);
      const cy = insetY + Math.floor((availH - side) / 2);
      return [
        { x: insetX + Math.floor((cardW - side) / 2), y: cy, w: side, h: side, index: 0 },
        { x: insetX + cardW + CARD_GAP + Math.floor((cardW - side) / 2), y: cy, w: side, h: side, index: 1 },
      ];
    }
  }

  const cols = 2;
  const rows = 2;
  const cellW = Math.floor((availW - CARD_GAP * (cols - 1)) / cols);
  const cellH = Math.floor((availH - CARD_GAP * (rows - 1)) / rows);
  const side = Math.min(cellW, cellH);

  const placements: CardPlacement[] = [];
  for (let i = 0; i < qrCount; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cellX = insetX + col * (cellW + CARD_GAP);
    const cellY = insetY + row * (cellH + CARD_GAP);
    placements.push({
      x: cellX + Math.floor((cellW - side) / 2),
      y: cellY + Math.floor((cellH - side) / 2),
      w: side,
      h: side,
      index: i,
    });
  }
  return placements;
}

export function impactFrames(qrCount: number): ImpactTiming[] {
  const impacts: ImpactTiming[] = [];
  for (let i = 0; i < qrCount; i++) {
    impacts.push({
      frame: FIRST_IMPACT_FRAME + i * IMPACT_INTERVAL_FRAMES,
      cardIndex: i,
    });
  }
  return impacts;
}

export function totalDuration(qrCount: number): { frames: number; seconds: number } {
  const lastImpactS = FIRST_IMPACT_S + (qrCount - 1) * IMPACT_INTERVAL_S;
  const durationS = Math.max(MIN_DURATION_S, lastImpactS + TAIL_AFTER_LAST_IMPACT_S);
  const frames = Math.round(durationS * FPS);
  return { frames, seconds: frames / FPS };
}

export function buildOutroSpec(ratio: AspectRatio, qrCount: number): OutroSpec {
  const layout = splitLayout(ratio);
  const cards = cardPlacements(qrCount, layout.panelRect, layout.splitAxis);
  const impacts = impactFrames(qrCount);
  const dur = totalDuration(qrCount);
  return {
    layout,
    cards,
    impacts,
    totalDurationFrames: dur.frames,
    totalDurationSeconds: dur.seconds,
    fps: FPS,
  };
}

export function cardAnimationProgress(
  currentFrame: number,
  impactFrame: number,
): {
  visible: boolean;
  opacity: number;
  translateFraction: number;
  rotation: number;
  scale: number;
} {
  if (currentFrame < impactFrame) {
    return { visible: false, opacity: 0, translateFraction: 1, rotation: 0, scale: 1 };
  }

  const elapsed = currentFrame - impactFrame;

  if (elapsed < ENTRY_FRAMES) {
    const t = elapsed / ENTRY_FRAMES;
    const eased = 1 - Math.pow(1 - t, 2);
    return {
      visible: true,
      opacity: eased,
      translateFraction: 1 - eased,
      rotation: (1 - eased) * 8,
      scale: elapsed === ENTRY_FRAMES - 1 ? 0.95 : 1 - (1 - eased) * 0.05,
    };
  }

  const settleElapsed = elapsed - ENTRY_FRAMES;
  const settleDuration = 4;
  if (settleElapsed < settleDuration) {
    const t = settleElapsed / settleDuration;
    const spring = 1 + 0.05 * Math.sin(t * Math.PI) * (1 - t);
    return {
      visible: true,
      opacity: 1,
      translateFraction: 0,
      rotation: 0,
      scale: spring,
    };
  }

  return { visible: true, opacity: 1, translateFraction: 0, rotation: 0, scale: 1 };
}

export function cueWindows(
  qrCount: number,
  totalFrames: number,
): CueWindow[] {
  const impacts = impactFrames(qrCount);
  const windows: CueWindow[] = [];

  for (let i = 0; i < impacts.length; i++) {
    const start = impacts[i].frame;
    let end: number;
    if (i < impacts.length - 1) {
      end = impacts[i + 1].frame;
    } else {
      end = Math.min(
        start + Math.round(MAX_FINAL_CUE_S * FPS),
        totalFrames,
      );
    }
    windows.push({ startFrame: start, endFrame: end, impactIndex: i });
  }

  return windows;
}
