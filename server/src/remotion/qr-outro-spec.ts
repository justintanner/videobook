export type AspectRatio = "16:9" | "9:16" | "1:1";
export type QrOutroOrientation = "landscape" | "portrait" | "square";

type QrLayout = {
  width: number;
  height: number;
  contentRect: { x: number; y: number; w: number; h: number };
  entryEdge: "right" | "bottom";
};

type CardPlacement = {
  x: number;
  y: number;
  w: number;
  h: number;
  index: number;
};

type CardEntryOffset = {
  x: number;
  y: number;
};

type ImpactTiming = {
  frame: number;
  cardIndex: number;
};

type OutroSpec = {
  layout: QrLayout;
  cards: CardPlacement[];
  impacts: ImpactTiming[];
  totalDurationFrames: number;
  totalDurationSeconds: number;
  fps: number;
};

type CueWindow = {
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
const ENTRY_FRAMES = IMPACT_INTERVAL_FRAMES;
const ENTRY_OVERSCAN_FRACTION = 0.25;
const MAX_FINAL_CUE_S = 0.6;

const BACKGROUND_COLOR = "#0A0A0A";
const LAYOUT_PAD = 24;
const CARD_GAP = 16;

export {
  FPS,
  IMPACT_INTERVAL_FRAMES,
  FIRST_IMPACT_FRAME,
  ENTRY_FRAMES,
  MAX_FINAL_CUE_S,
  BACKGROUND_COLOR,
  LAYOUT_PAD,
};

export function qrLayout(ratio: AspectRatio): QrLayout {
  switch (ratio) {
    case "16:9": {
      const w = 1920;
      const h = 1080;
      return {
        width: w,
        height: h,
        contentRect: { x: 0, y: 0, w, h },
        entryEdge: "right",
      };
    }
    case "9:16": {
      const w = 1080;
      const h = 1920;
      return {
        width: w,
        height: h,
        contentRect: { x: 0, y: 0, w, h },
        entryEdge: "bottom",
      };
    }
    case "1:1": {
      const w = 1080;
      const h = 1080;
      return {
        width: w,
        height: h,
        contentRect: { x: 0, y: 0, w, h },
        entryEdge: "right",
      };
    }
  }
}

export function orientationForAspectRatio(
  ratio: AspectRatio,
): QrOutroOrientation {
  if (ratio === "9:16") return "portrait";
  if (ratio === "1:1") return "square";
  return "landscape";
}

export function cardPlacements(
  qrCount: number,
  contentRect: { x: number; y: number; w: number; h: number },
): CardPlacement[] {
  if (qrCount < 1 || qrCount > 4) {
    throw new Error(`qrCount must be 1-4, got ${qrCount}`);
  }

  const insetX = contentRect.x + LAYOUT_PAD;
  const insetY = contentRect.y + LAYOUT_PAD;
  const availW = contentRect.w - LAYOUT_PAD * 2;
  const availH = contentRect.h - LAYOUT_PAD * 2;

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
    if (availW >= availH) {
      const cardW = Math.floor((availW - CARD_GAP) / 2);
      const side = Math.min(cardW, availH);
      const cy = insetY + Math.floor((availH - side) / 2);
      return [
        { x: insetX + Math.floor((cardW - side) / 2), y: cy, w: side, h: side, index: 0 },
        { x: insetX + cardW + CARD_GAP + Math.floor((cardW - side) / 2), y: cy, w: side, h: side, index: 1 },
      ];
    }

    const cardH = Math.floor((availH - CARD_GAP) / 2);
    const side = Math.min(availW, cardH);
    const cx = insetX + Math.floor((availW - side) / 2);
    return [
      { x: cx, y: insetY + Math.floor((cardH - side) / 2), w: side, h: side, index: 0 },
      { x: cx, y: insetY + cardH + CARD_GAP + Math.floor((cardH - side) / 2), w: side, h: side, index: 1 },
    ];
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

export function cardEntryOffset(
  placement: CardPlacement,
  layout: QrLayout,
): CardEntryOffset {
  const driftDirection = placement.index % 2 === 0 ? -1 : 1;
  const overscan = Math.ceil(
    Math.max(placement.w, placement.h) * ENTRY_OVERSCAN_FRACTION,
  );

  if (layout.entryEdge === "right") {
    return {
      x: layout.width - placement.x + overscan,
      y: driftDirection * placement.h * 0.12,
    };
  }

  return {
    x: driftDirection * placement.w * 0.12,
    y: layout.height - placement.y + overscan,
  };
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

export function totalDuration(
  qrCount: number,
  requestedSeconds?: number,
): { frames: number; seconds: number } {
  const lastImpactS = FIRST_IMPACT_S + (qrCount - 1) * IMPACT_INTERVAL_S;
  const minimumDurationS = Math.max(
    MIN_DURATION_S,
    lastImpactS + TAIL_AFTER_LAST_IMPACT_S,
  );
  const durationS = Math.max(minimumDurationS, requestedSeconds ?? 0);
  const frames = Math.round(durationS * FPS);
  return { frames, seconds: frames / FPS };
}

export function buildOutroSpec(
  ratio: AspectRatio,
  qrCount: number,
  requestedSeconds?: number,
): OutroSpec {
  const layout = qrLayout(ratio);
  const cards = cardPlacements(qrCount, layout.contentRect);
  const impacts = impactFrames(qrCount);
  const dur = totalDuration(qrCount, requestedSeconds);
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
  const entryStart = impactFrame - ENTRY_FRAMES;
  if (currentFrame < entryStart) {
    return {
      visible: false,
      opacity: 0,
      translateFraction: 1,
      rotation: 8,
      scale: 1.2,
    };
  }

  if (currentFrame < impactFrame) {
    const elapsed = currentFrame - entryStart;
    const t = elapsed / ENTRY_FRAMES;
    const eased = 1 - Math.pow(1 - t, 2);
    return {
      visible: true,
      opacity: eased,
      translateFraction: 1 - eased,
      rotation: (1 - eased) * 8,
      scale: 1.2 - eased * 0.26,
    };
  }

  const settleElapsed = currentFrame - impactFrame;
  const settleDuration = 6;
  if (settleElapsed < settleDuration) {
    const t = settleElapsed / settleDuration;
    const spring = 0.94 + 0.06 * t + 0.045 * Math.sin(t * Math.PI * 2) * (1 - t);
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
