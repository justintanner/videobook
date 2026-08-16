import QRCode from "qrcode";

const PATTERN_POSITION_TABLE: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

const QRPointType = {
  DATA: 0,
  POS_CENTER: 1,
  POS_OTHER: 2,
  ALIGN_CENTER: 3,
  ALIGN_OTHER: 4,
  TIMING: 5,
  FORMAT: 6,
  VERSION: 7,
} as const;

const SQ25_PATH =
  "M32.048565,-1.29480038e-15 L67.951435,1.29480038e-15 C79.0954192,-7.52316311e-16 83.1364972,1.16032014 87.2105713,3.3391588 C91.2846454,5.51799746 94.4820025,8.71535463 96.6608412,12.7894287 C98.8396799,16.8635028 100,20.9045808 100,32.048565 L100,67.951435 C100,79.0954192 98.8396799,83.1364972 96.6608412,87.2105713 C94.4820025,91.2846454 91.2846454,94.4820025 87.2105713,96.6608412 C83.1364972,98.8396799 79.0954192,100 67.951435,100 L32.048565,100 C20.9045808,100 16.8635028,98.8396799 12.7894287,96.6608412 C8.71535463,94.4820025 5.51799746,91.2846454 3.3391588,87.2105713 C1.16032014,83.1364972 5.01544207e-16,79.0954192 -8.63200256e-16,67.951435 L8.63200256e-16,32.048565 C-5.01544207e-16,20.9045808 1.16032014,16.8635028 3.3391588,12.7894287 C5.51799746,8.71535463 8.71535463,5.51799746 12.7894287,3.3391588 C16.8635028,1.16032014 20.9045808,7.52316311e-16 32.048565,-1.29480038e-15 Z";

let randSeed = 142857;
function rand(min: number, max: number): number {
  randSeed = (randSeed * 9301 + 49297) % 233280;
  return min + (randSeed / 233280.0) * (max - min);
}
function resetRand(seed = 142857): void {
  randSeed = seed;
}

interface QrMatrix {
  isDark(x: number, y: number): boolean;
  getModuleCount(): number;
  getPositionTable(): number[][];
}

function getAlignmentPositions(version: number, nCount: number): number[][] {
  const pos = PATTERN_POSITION_TABLE[version - 1];
  const positions: number[][] = [];
  for (const row of pos) {
    for (const col of pos) {
      if (row <= 8 && col <= 8) continue;
      if (row <= 8 && col >= nCount - 8) continue;
      if (row >= nCount - 8 && col <= 8) continue;
      positions.push([row, col]);
    }
  }
  return positions;
}

function createQrMatrix(
  value: string,
  level: "H" | "M" | "Q" | "L",
): { matrix: QrMatrix; version: number } {
  const qr = QRCode.create(value, { errorCorrectionLevel: level });
  const nCount = qr.modules.size;
  const alignmentPositions = getAlignmentPositions(qr.version, nCount);
  return {
    version: qr.version,
    matrix: {
      isDark: (x: number, y: number) => qr.modules.get(y, x) === 1,
      getModuleCount: () => nCount,
      getPositionTable: () => alignmentPositions,
    },
  };
}

function getTypeTable(qr: QrMatrix): number[][] {
  const nCount = qr.getModuleCount();
  const position = qr.getPositionTable();
  const PD = [
    [3, 3],
    [3, nCount - 4],
    [nCount - 4, 3],
  ];

  const typeTable: number[][] = new Array(nCount);
  for (let i = 0; i < nCount; i++) typeTable[i] = new Array(nCount);

  for (let i = 8; i < nCount - 7; i++) {
    typeTable[i][6] = QRPointType.TIMING;
    typeTable[6][i] = QRPointType.TIMING;
  }

  for (const [row, col] of position) {
    typeTable[row][col] = QRPointType.ALIGN_CENTER;
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        if (!(r === 0 && c === 0)) typeTable[row + r][col + c] = QRPointType.ALIGN_OTHER;
      }
    }
  }

  for (const [row, col] of PD) {
    typeTable[row][col] = QRPointType.POS_CENTER;
    for (let r = -4; r <= 4; r++) {
      for (let c = -4; c <= 4; c++) {
        if (row + r >= 0 && row + r < nCount && col + c >= 0 && col + c < nCount) {
          if (!(r === 0 && c === 0)) typeTable[row + r][col + c] = QRPointType.POS_OTHER;
        }
      }
    }
  }

  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      typeTable[i][8] = QRPointType.FORMAT;
      typeTable[8][i] = QRPointType.FORMAT;
    }
    if (i < 7) typeTable[nCount - i - 1][8] = QRPointType.FORMAT;
    if (i < 8) typeTable[8][nCount - i - 1] = QRPointType.FORMAT;
  }

  for (let i = nCount - 11; i <= nCount - 9; i++) {
    for (let j = 0; j <= 5; j++) {
      typeTable[i][j] = QRPointType.VERSION;
      typeTable[j][i] = QRPointType.VERSION;
    }
  }

  for (let i = 0; i < nCount; i++) {
    for (let j = 0; j < nCount; j++) {
      if (typeTable[i][j] === undefined) typeTable[i][j] = QRPointType.DATA;
    }
  }

  return typeTable;
}

function defaultViewBox(nCount: number): string {
  const margin = nCount / 5;
  return `${-margin} ${-margin} ${nCount + margin * 2} ${nCount + margin * 2}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function svgRect(
  x: number, y: number, w: number, h: number, fill: string, opacity?: number,
  stroke?: string, sw?: number,
): string {
  let a = `x="${x}" y="${y}" width="${w}" height="${h}" fill="${esc(fill)}"`;
  if (opacity != null && opacity !== 1) a += ` opacity="${opacity}"`;
  if (stroke) a += ` stroke="${esc(stroke)}"`;
  if (sw != null) a += ` stroke-width="${sw}"`;
  return `<rect ${a}/>`;
}

function svgCircle(
  cx: number, cy: number, r: number, fill: string,
  opacity?: number, stroke?: string, sw?: number, dash?: string,
): string {
  let a = `cx="${cx}" cy="${cy}" r="${r}"`;
  a += fill === "none" ? ` fill="none"` : ` fill="${esc(fill)}"`;
  if (opacity != null && opacity !== 1) a += ` opacity="${opacity}"`;
  if (stroke) a += ` stroke="${esc(stroke)}"`;
  if (sw != null) a += ` stroke-width="${sw}"`;
  if (dash) a += ` stroke-dasharray="${dash}"`;
  return `<circle ${a}/>`;
}

function svgLine(
  x1: number, y1: number, x2: number, y2: number,
  stroke: string, sw: number, opacity?: number, cap?: string,
): string {
  let a = `x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${esc(stroke)}" stroke-width="${sw}"`;
  if (opacity != null && opacity !== 1) a += ` opacity="${opacity}"`;
  if (cap) a += ` stroke-linecap="${cap}"`;
  return `<line ${a}/>`;
}

function svgPath(
  d: string, stroke: string, sw: number, fill: string, transform?: string,
): string {
  let a = `d="${d}" stroke="${esc(stroke)}" stroke-width="${sw}" fill="${esc(fill)}"`;
  if (transform) a += ` transform="${transform}"`;
  return `<path ${a}/>`;
}

const VW = [3, -3];
const VH = [3, -3];

function renderPosCenter(
  x: number, y: number, posType: string, posColor: string, size: number,
): string {
  if (posType === "rect") {
    return svgRect(x, y, 1, 1, posColor);
  }
  if (posType === "round") {
    return svgCircle(x + 0.5, y + 0.5, 1.5, posColor) + svgCircle(x + 0.5, y + 0.5, 3, "none", undefined, posColor, 1);
  }
  if (posType === "planet") {
    let s = svgCircle(x + 0.5, y + 0.5, 1.5, posColor);
    s += svgCircle(x + 0.5, y + 0.5, 3, "none", undefined, posColor, 0.15, "0.5,0.5");
    for (const w of VW) s += svgCircle(x + w + 0.5, y + 0.5, 0.5, posColor);
    for (const h of VH) s += svgCircle(x + 0.5, y + h + 0.5, 0.5, posColor);
    return s;
  }
  if (posType === "roundRect") {
    let s = svgCircle(x + 0.5, y + 0.5, 1.5, posColor);
    const sw = (100 / 6) * (1 - (1 - size) * 0.75);
    const tr = `translate(${x - 2.5},${y - 2.5}) scale(${6 / 100},${6 / 100})`;
    s += svgPath(SQ25_PATH, posColor, sw, "none", tr);
    return s;
  }
  return "";
}

function renderPosOther(x: number, y: number, posType: string, posColor: string): string {
  if (posType === "rect") return svgRect(x, y, 1, 1, posColor);
  return "";
}

type NormalType = "rect" | "round" | "rand";
type PosType = "rect" | "round" | "planet" | "roundRect";

function renderNormal(
  qr: QrMatrix,
  tt: number[][],
  p: {
    pointType: NormalType;
    pointSize: number;
    pointOpacity: number;
    posType: PosType;
    otherColor: string;
    posColor: string;
  },
): string {
  const nCount = qr.getModuleCount();
  const type = p.pointType;
  const size = p.pointSize / 100;
  const opacity = p.pointOpacity / 100;
  let svg = "";

  for (let x = 0; x < nCount; x++) {
    for (let y = 0; y < nCount; y++) {
      if (!qr.isDark(x, y)) continue;
      const t = tt[x][y];

      if (t === QRPointType.ALIGN_CENTER || t === QRPointType.ALIGN_OTHER || t === QRPointType.TIMING) {
        if (type === "rect") {
          svg += svgRect(x + (1 - size) / 2, y + (1 - size) / 2, size, size, p.otherColor, opacity);
        } else {
          svg += svgCircle(x + 0.5, y + 0.5, size / 2, p.otherColor, opacity);
        }
      } else if (t === QRPointType.POS_CENTER) {
        svg += renderPosCenter(x, y, p.posType, p.posColor, size);
      } else if (t === QRPointType.POS_OTHER) {
        svg += renderPosOther(x, y, p.posType, p.posColor);
      } else {
        if (type === "rect") {
          svg += svgRect(x + (1 - size) / 2, y + (1 - size) / 2, size, size, p.otherColor, opacity);
        } else if (type === "round") {
          svg += svgCircle(x + 0.5, y + 0.5, size / 2, p.otherColor, opacity);
        } else {
          svg += svgCircle(x + 0.5, y + 0.5, 0.5 * rand(0.33, 1.0), p.otherColor, opacity);
        }
      }
    }
  }
  return svg;
}

type LineDirection =
  | "left-right" | "up-down" | "h-v" | "loop"
  | "topLeft-bottomRight" | "topRight-bottomLeft" | "cross";

function renderLine(
  qr: QrMatrix,
  tt: number[][],
  p: {
    direction: LineDirection;
    lineWidth: number;
    lineOpacity: number;
    posType: PosType;
    lineColor: string;
    posColor: string;
  },
): string {
  const nCount = qr.getModuleCount();
  const type = p.direction;
  let size = p.lineWidth / 100;
  const opacity = p.lineOpacity / 100;
  const otherColor = p.lineColor;
  if (size <= 0) size = 1.0;

  const available: boolean[][] = [];
  const ava2: boolean[][] = [];
  for (let x = 0; x < nCount; x++) {
    available[x] = [];
    ava2[x] = [];
    for (let y = 0; y < nCount; y++) {
      available[x][y] = true;
      ava2[x][y] = true;
    }
  }

  let svg = "";

  for (let x = 0; x < nCount; x++) {
    for (let y = 0; y < nCount; y++) {
      if (!qr.isDark(x, y)) continue;
      const t = tt[x][y];

      if (t === QRPointType.POS_CENTER) {
        svg += renderPosCenter(x, y, p.posType, p.posColor, size);
      } else if (t === QRPointType.POS_OTHER) {
        svg += renderPosOther(x, y, p.posType, p.posColor);
      } else {
        if (type === "left-right") {
          if (x === 0 || (x > 0 && (!qr.isDark(x - 1, y) || !ava2[x - 1][y]))) {
            let end = 0;
            let ctn = true;
            while (ctn && x + end < nCount) {
              if (qr.isDark(x + end, y) && ava2[x + end][y]) end++;
              else ctn = false;
            }
            if (end > 1) {
              for (let i = 0; i < end; i++) {
                ava2[x + i][y] = false;
                available[x + i][y] = false;
              }
              svg += svgLine(x + 0.5, y + 0.5, x + end - 0.5, y + 0.5, otherColor, size, opacity, "round");
            }
          }
          if (available[x][y]) svg += svgCircle(x + 0.5, y + 0.5, size / 2, otherColor, opacity);
        }

        if (type === "up-down") {
          if (y === 0 || (y > 0 && (!qr.isDark(x, y - 1) || !ava2[x][y - 1]))) {
            let end = 0;
            let ctn = true;
            while (ctn && y + end < nCount) {
              if (qr.isDark(x, y + end) && ava2[x][y + end]) end++;
              else ctn = false;
            }
            if (end > 1) {
              for (let i = 0; i < end; i++) {
                ava2[x][y + i] = false;
                available[x][y + i] = false;
              }
              svg += svgLine(x + 0.5, y + 0.5, x + 0.5, y + end - 1 + 0.5, otherColor, size, opacity, "round");
            }
          }
          if (available[x][y]) svg += svgCircle(x + 0.5, y + 0.5, size / 2, otherColor, opacity);
        }

        if (type === "h-v") {
          if (y === 0 || (y > 0 && (!qr.isDark(x, y - 1) || !ava2[x][y - 1]))) {
            let end = 0;
            let ctn = true;
            while (ctn && y + end < nCount) {
              if (qr.isDark(x, y + end) && ava2[x][y + end] && end <= 3) end++;
              else ctn = false;
            }
            if (end > 1) {
              for (let i = 0; i < end; i++) {
                ava2[x][y + i] = false;
                available[x][y + i] = false;
              }
              svg += svgLine(x + 0.5, y + 0.5, x + 0.5, y + end - 1 + 0.5, otherColor, size, opacity, "round");
            }
          }
          if (x === 0 || (x > 0 && (!qr.isDark(x - 1, y) || !ava2[x - 1][y]))) {
            let end = 0;
            let ctn = true;
            while (ctn && x + end < nCount) {
              if (qr.isDark(x + end, y) && ava2[x + end][y] && end <= 3) end++;
              else ctn = false;
            }
            if (end > 1) {
              for (let i = 0; i < end; i++) {
                ava2[x + i][y] = false;
                available[x + i][y] = false;
              }
              svg += svgLine(x + 0.5, y + 0.5, x + end - 0.5, y + 0.5, otherColor, size, opacity, "round");
            }
          }
          if (available[x][y]) svg += svgCircle(x + 0.5, y + 0.5, size / 2, otherColor, opacity);
        }

        if (type === "loop") {
          if ((Number(x > y) ^ Number(x + y < nCount)) as unknown as boolean) {
            if (y === 0 || (y > 0 && (!qr.isDark(x, y - 1) || !ava2[x][y - 1]))) {
              let end = 0;
              let ctn = true;
              while (ctn && y + end < nCount) {
                if (qr.isDark(x, y + end) && ava2[x][y + end] && end <= 3) end++;
                else ctn = false;
              }
              if (end > 1) {
                for (let i = 0; i < end; i++) {
                  ava2[x][y + i] = false;
                  available[x][y + i] = false;
                }
                svg += svgLine(x + 0.5, y + 0.5, x + 0.5, y + end - 1 + 0.5, otherColor, size, opacity, "round");
              }
            }
          } else {
            if (x === 0 || (x > 0 && (!qr.isDark(x - 1, y) || !ava2[x - 1][y]))) {
              let end = 0;
              let ctn = true;
              while (ctn && x + end < nCount) {
                if (qr.isDark(x + end, y) && ava2[x + end][y] && end <= 3) end++;
                else ctn = false;
              }
              if (end > 1) {
                for (let i = 0; i < end; i++) {
                  ava2[x + i][y] = false;
                  available[x + i][y] = false;
                }
                svg += svgLine(x + 0.5, y + 0.5, x + end - 0.5, y + 0.5, otherColor, size, opacity, "round");
              }
            }
          }
          if (available[x][y]) svg += svgCircle(x + 0.5, y + 0.5, size / 2, otherColor, opacity);
        }

        if (type === "topLeft-bottomRight") {
          if (y === 0 || x === 0 || ((y > 0 && x > 0) && (!qr.isDark(x - 1, y - 1) || !ava2[x - 1][y - 1]))) {
            let end = 0;
            let ctn = true;
            while (ctn && y + end < nCount && x + end < nCount) {
              if (qr.isDark(x + end, y + end) && ava2[x + end][y + end]) end++;
              else ctn = false;
            }
            if (end > 1) {
              for (let i = 0; i < end; i++) {
                ava2[x + i][y + i] = false;
                available[x + i][y + i] = false;
              }
              svg += svgLine(x + 0.5, y + 0.5, x + end - 1 + 0.5, y + end - 1 + 0.5, otherColor, size, opacity, "round");
            }
          }
          if (available[x][y]) svg += svgCircle(x + 0.5, y + 0.5, size / 2, otherColor, opacity);
        }

        if (type === "topRight-bottomLeft") {
          if (x === 0 || y === nCount - 1 || ((x > 0 && y < nCount - 1) && (!qr.isDark(x - 1, y + 1) || !ava2[x - 1][y + 1]))) {
            let end = 0;
            let ctn = true;
            while (ctn && x + end < nCount && y - end >= 0) {
              if (qr.isDark(x + end, y - end) && available[x + end][y - end]) end++;
              else ctn = false;
            }
            if (end > 1) {
              for (let i = 0; i < end; i++) {
                ava2[x + i][y - i] = false;
                available[x + i][y - i] = false;
              }
              svg += svgLine(x + 0.5, y + 0.5, x + (end - 1) + 0.5, y - (end - 1) + 0.5, otherColor, size, opacity, "round");
            }
          }
          if (available[x][y]) svg += svgCircle(x + 0.5, y + 0.5, size / 2, otherColor, opacity);
        }

        if (type === "cross") {
          if (x === 0 || y === nCount - 1 || ((x > 0 && y < nCount - 1) && (!qr.isDark(x - 1, y + 1) || !ava2[x - 1][y + 1]))) {
            let end = 0;
            let ctn = true;
            while (ctn && x + end < nCount && y - end >= 0) {
              if (qr.isDark(x + end, y - end) && ava2[x + end][y - end]) end++;
              else ctn = false;
            }
            if (end > 1) {
              for (let i = 0; i < end; i++) ava2[x + i][y - i] = false;
              svg += svgLine(x + 0.5, y + 0.5, x + (end - 1) + 0.5, y - (end - 1) + 0.5, otherColor, (size / 2) * rand(0.3, 1), opacity, "round");
            }
          }
          if (y === 0 || x === 0 || ((y > 0 && x > 0) && (!qr.isDark(x - 1, y - 1) || !available[x - 1][y - 1]))) {
            let end = 0;
            let ctn = true;
            while (ctn && y + end < nCount && x + end < nCount) {
              if (qr.isDark(x + end, y + end) && available[x + end][y + end]) end++;
              else ctn = false;
            }
            if (end > 1) {
              for (let i = 0; i < end; i++) available[x + i][y + i] = false;
              svg += svgLine(x + 0.5, y + 0.5, x + end - 1 + 0.5, y + end - 1 + 0.5, otherColor, (size / 2) * rand(0.3, 1), opacity, "round");
            }
          }
          svg += svgCircle(x + 0.5, y + 0.5, 0.5 * rand(0.33, 0.9), otherColor, opacity);
        }
      }
    }
  }
  return svg;
}

function renderDsj(
  qr: QrMatrix,
  tt: number[][],
  p: { scale: number; crossWidth: number; posWidth: number; posType: "rect" | "dsj" },
): string {
  const nCount = qr.getModuleCount();
  const scale = p.scale / 100;
  const crossWidth = p.crossWidth / 100;
  const posWidth = p.posWidth / 100;
  const posType = p.posType;

  const available: boolean[][] = [];
  const available2: boolean[][] = [];
  for (let x = 0; x < nCount; x++) {
    available[x] = [];
    available2[x] = [];
    for (let y = 0; y < nCount; y++) {
      available[x][y] = true;
      available2[x][y] = true;
    }
  }

  const pointList: string[] = [];
  const g1: string[] = [];
  const g2: string[] = [];

  const BLUE = "#5B8DEF";
  const RED = "#FF5252";
  const YELLOW = "#FFD93D";
  const inv = 1 - posWidth;

  for (let y = 0; y < nCount; y++) {
    for (let x = 0; x < nCount; x++) {
      if (!qr.isDark(x, y)) continue;
      const t = tt[x][y];

      if (t === QRPointType.POS_CENTER) {
        if (posType === "rect") {
          pointList.push(svgRect(x, y, 1, 1, BLUE));
        } else {
          pointList.push(svgRect(x - 1 + inv / 2, y - 1 + inv / 2, 3 - inv, 3 - inv, BLUE));
          pointList.push(svgRect(x - 3 + inv / 2, y - 1 + inv / 2, posWidth, 3 - inv, BLUE));
          pointList.push(svgRect(x + 3 + inv / 2, y - 1 + inv / 2, posWidth, 3 - inv, BLUE));
          pointList.push(svgRect(x - 1 + inv / 2, y - 3 + inv / 2, 3 - inv, posWidth, BLUE));
          pointList.push(svgRect(x - 1 + inv / 2, y + 3 + inv / 2, 3 - inv, posWidth, BLUE));
        }
      } else if (t === QRPointType.POS_OTHER) {
        if (posType === "rect") pointList.push(svgRect(x, y, 1, 1, BLUE));
      } else {
        if (available[x][y] && available2[x][y] && x < nCount - 2 && y < nCount - 2) {
          let ctn = true;
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (!available2[x + i][y + j]) ctn = false;
          if (ctn && qr.isDark(x + 2, y) && qr.isDark(x + 1, y + 1) && qr.isDark(x, y + 2) && qr.isDark(x + 2, y + 2)) {
            const o = crossWidth / Math.sqrt(8);
            g1.push(svgLine(x + o, y + o, x + 3 - o, y + 3 - o, BLUE, crossWidth));
            g1.push(svgLine(x + 3 - o, y + o, x + o, y + 3 - o, BLUE, crossWidth));
            available[x][y] = false;
            available[x + 2][y] = false;
            available[x][y + 2] = false;
            available[x + 2][y + 2] = false;
            available[x + 1][y + 1] = false;
            for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) available2[x + i][y + j] = false;
          }
        }
        if (available[x][y] && available2[x][y] && x < nCount - 1 && y < nCount - 1) {
          let ctn = true;
          for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) if (!available2[x + i][y + j]) ctn = false;
          if (ctn && qr.isDark(x + 1, y) && qr.isDark(x, y + 1) && qr.isDark(x + 1, y + 1)) {
            const o = crossWidth / Math.sqrt(8);
            g1.push(svgLine(x + o, y + o, x + 2 - o, y + 2 - o, BLUE, crossWidth));
            g1.push(svgLine(x + 2 - o, y + o, x + o, y + 2 - o, BLUE, crossWidth));
            for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
              available[x + i][y + j] = false;
              available2[x + i][y + j] = false;
            }
          }
        }
        if (available[x][y] && available2[x][y]) {
          if (y === 0 || (y > 0 && (!qr.isDark(x, y - 1) || !available2[x][y - 1]))) {
            const start = y;
            let end = y;
            let ctn = true;
            while (ctn && end < nCount) {
              if (qr.isDark(x, end) && available2[x][end]) end++;
              else ctn = false;
            }
            if (end - start > 2) {
              for (let i = start; i < end; i++) {
                available2[x][i] = false;
                available[x][i] = false;
              }
              g2.push(svgRect(x + (1 - scale) / 2, y + (1 - scale) / 2, scale, end - start - 1 - (1 - scale), RED));
              g2.push(svgRect(x + (1 - scale) / 2, end - 1 + (1 - scale) / 2, scale, scale, RED));
            }
          }
        }
        if (available[x][y] && available2[x][y]) {
          if (x === 0 || (x > 0 && (!qr.isDark(x - 1, y) || !available2[x - 1][y]))) {
            const start = x;
            let end = x;
            let ctn = true;
            while (ctn && end < nCount) {
              if (qr.isDark(end, y) && available2[end][y]) end++;
              else ctn = false;
            }
            if (end - start > 1) {
              for (let i = start; i < end; i++) {
                available2[i][y] = false;
                available[i][y] = false;
              }
              g2.push(svgRect(x + (1 - scale) / 2, y + (1 - scale) / 2, end - start - (1 - scale), scale, YELLOW));
            }
          }
        }
        if (available[x][y]) {
          pointList.push(svgRect(x + (1 - scale) / 2, y + (1 - scale) / 2, scale, scale, YELLOW));
        }
      }
    }
  }

  for (const s of g1) pointList.push(s);
  for (const s of g2) pointList.push(s);
  return pointList.join("");
}

function renderBubble(
  qr: QrMatrix,
  tt: number[][],
  p: { circleColor: string; posColor: string; bgColor: string },
): string {
  const nCount = qr.getModuleCount();
  const pointList: string[] = [];
  const g1: string[] = [];
  const g2: string[] = [];

  const available: boolean[][] = [];
  const ava2: boolean[][] = [];
  for (let x = 0; x < nCount; x++) {
    available[x] = [];
    ava2[x] = [];
    for (let y = 0; y < nCount; y++) {
      available[x][y] = true;
      ava2[x][y] = true;
    }
  }

  for (let y = 0; y < nCount; y++) {
    for (let x = 0; x < nCount; x++) {
      if (qr.isDark(x, y) && tt[x][y] === QRPointType.POS_CENTER) {
        pointList.push(svgCircle(x + 0.5, y + 0.5, 1.5, p.posColor));
        pointList.push(svgCircle(x + 0.5, y + 0.5, 3, "none", undefined, p.posColor, 1));
      } else if (qr.isDark(x, y) && tt[x][y] === QRPointType.POS_OTHER) {
        // skip
      } else {
        if (available[x][y] && ava2[x][y] && x < nCount - 2 && y < nCount - 2) {
          let ctn = true;
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (!ava2[x + i][y + j]) ctn = false;
          if (ctn && qr.isDark(x + 1, y) && qr.isDark(x + 1, y + 2) && qr.isDark(x, y + 1) && qr.isDark(x + 2, y + 1)) {
            g1.push(svgCircle(x + 1.5, y + 1.5, 1, p.bgColor, undefined, p.circleColor, rand(0.33, 0.6)));
            if (qr.isDark(x + 1, y + 1)) {
              g1.push(svgCircle(x + 1.5, y + 1.5, 0.5 * rand(0.5, 1), p.circleColor));
            }
            available[x + 1][y] = false;
            available[x][y + 1] = false;
            available[x + 2][y + 1] = false;
            available[x + 1][y + 2] = false;
            for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) ava2[x + i][y + j] = false;
          }
        }
        if (x < nCount - 1 && y < nCount - 1) {
          if (qr.isDark(x, y) && qr.isDark(x + 1, y) && qr.isDark(x, y + 1) && qr.isDark(x + 1, y + 1)) {
            g1.push(svgCircle(x + 1, y + 1, Math.sqrt(1 / 2), p.bgColor, undefined, p.circleColor, rand(0.33, 0.6)));
            for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
              available[x + i][y + j] = false;
              ava2[x + i][y + j] = false;
            }
          }
        }
        if (available[x][y] && y < nCount - 1) {
          if (qr.isDark(x, y) && qr.isDark(x, y + 1)) {
            pointList.push(svgCircle(x + 0.5, y + 1, 0.5 * rand(0.95, 1.05), p.bgColor, undefined, p.circleColor, rand(0.36, 0.4)));
            available[x][y] = false;
            available[x][y + 1] = false;
          }
        }
        if (available[x][y] && x < nCount - 1) {
          if (qr.isDark(x, y) && qr.isDark(x + 1, y)) {
            pointList.push(svgCircle(x + 1, y + 0.5, 0.5 * rand(0.95, 1.05), p.bgColor, undefined, p.circleColor, rand(0.36, 0.4)));
            available[x][y] = false;
            available[x + 1][y] = false;
          }
        }
        if (available[x][y]) {
          if (qr.isDark(x, y)) {
            pointList.push(svgCircle(x + 0.5, y + 0.5, 0.5 * rand(0.5, 1), p.circleColor));
          } else if (tt[x][y] === QRPointType.DATA) {
            if (rand(0, 1) > 0.85) {
              g2.push(svgCircle(x + 0.5, y + 0.5, 0.5 * rand(0.85, 1.3), p.bgColor, undefined, p.circleColor, rand(0.15, 0.33)));
            }
          }
        }
      }
    }
  }

  for (const s of g1) pointList.push(s);
  for (const s of g2) pointList.push(s);
  return pointList.join("");
}

type FuncType = "A" | "B";
type FuncPointType = "rect" | "round";

function renderFunc(
  qr: QrMatrix,
  tt: number[][],
  p: {
    funcType: FuncType;
    pointType: FuncPointType;
    posType: PosType;
    otherColor1: string;
    otherColor2: string;
    posColor: string;
    bgColor: string;
  },
): string {
  const nCount = qr.getModuleCount();
  const type = p.pointType;
  const pointList: string[] = [];
  const size = 0.8;

  if (p.funcType === "B" && type === "round") {
    pointList.push(svgCircle(nCount / 2, nCount / 2, (nCount / 2) * Math.sqrt(2) * (13 / 40), "none", undefined, p.otherColor2, nCount / 15));
  }

  for (let x = 0; x < nCount; x++) {
    for (let y = 0; y < nCount; y++) {
      if (qr.isDark(x, y) && tt[x][y] === QRPointType.POS_CENTER) {
        pointList.push(renderPosCenter(x, y, p.posType, p.posColor, size));
      } else if (qr.isDark(x, y) && tt[x][y] === QRPointType.POS_OTHER) {
        pointList.push(renderPosOther(x, y, p.posType, p.posColor));
      } else {
        const dist = Math.sqrt(Math.pow((nCount - 1) / 2 - x, 2) + Math.pow((nCount - 1) / 2 - y, 2)) / ((nCount / 2) * Math.sqrt(2));

        if (p.funcType === "A") {
          let sizeF = (1 - Math.cos(Math.PI * dist)) / 6 + 1 / 5;
          const opacityF = qr.isDark(x, y) ? 1 : 0;
          if (type === "rect") {
            sizeF += 0.2;
            pointList.push(svgRect(x + (1 - sizeF) / 2, y + (1 - sizeF) / 2, sizeF, sizeF, p.otherColor1, opacityF));
          } else {
            pointList.push(svgCircle(x + 0.5, y + 0.5, sizeF, p.otherColor1, opacityF));
          }
        }

        if (p.funcType === "B") {
          let sizeF = 0;
          let colorF = p.otherColor1;
          let opacityF = qr.isDark(x, y) ? 1 : 0;
          if (dist > 5 / 20 && dist < 8 / 20) {
            sizeF = 5 / 10;
            colorF = p.otherColor2;
            opacityF = 1;
          } else {
            sizeF = 1 / 4;
            if (type === "rect") sizeF = 1 / 4 - 0.1;
          }
          if (type === "rect") {
            sizeF = 2 * sizeF + 0.1;
            if (qr.isDark(x, y)) {
              pointList.push(svgRect(x + (1 - sizeF) / 2, y + (1 - sizeF) / 2, sizeF, sizeF, colorF, opacityF));
            } else {
              sizeF -= 0.1;
              pointList.push(svgRect(x + (1 - sizeF) / 2, y + (1 - sizeF) / 2, sizeF, sizeF, p.bgColor, opacityF, colorF, 0.1));
            }
          } else {
            if (qr.isDark(x, y)) {
              pointList.push(svgCircle(x + 0.5, y + 0.5, sizeF, colorF, opacityF));
            } else {
              pointList.push(svgCircle(x + 0.5, y + 0.5, sizeF, p.bgColor, opacityF, colorF, 0.1));
            }
          }
        }
      }
    }
  }
  return pointList.join("");
}

export type QrbtfStyle = "normal" | "line" | "dsj" | "bubble" | "func";

export interface QrbtfParams {
  pointType?: "rect" | "round" | "rand";
  pointSize?: number;
  pointOpacity?: number;
  posType?: PosType;
  direction?: LineDirection;
  lineWidth?: number;
  lineOpacity?: number;
  scale?: number;
  crossWidth?: number;
  posWidth?: number;
  dsjPosType?: "rect" | "dsj";
  funcType?: FuncType;
  otherColor?: string;
  otherColor2?: string;
  posColor?: string;
  circleColor?: string;
  bgColor?: string;
}

export function buildQrbtfSvg(
  value: string,
  style: QrbtfStyle,
  params: QrbtfParams,
): { content: string; viewBox: string; version: number; moduleCount: number; bgColor: string } {
  resetRand();
  const { matrix, version } = createQrMatrix(value, "H");
  const tt = getTypeTable(matrix);
  const nCount = matrix.getModuleCount();
  const viewBox = defaultViewBox(nCount);
  const bgColor = params.bgColor ?? "#000000";

  let content: string;
  if (style === "normal") {
    content = renderNormal(matrix, tt, {
      pointType: (params.pointType ?? "rect") as NormalType,
      pointSize: params.pointSize ?? 100,
      pointOpacity: params.pointOpacity ?? 100,
      posType: (params.posType ?? "rect") as PosType,
      otherColor: params.otherColor ?? "#FFFFFF",
      posColor: params.posColor ?? "#FFFFFF",
    });
  } else if (style === "line") {
    content = renderLine(matrix, tt, {
      direction: (params.direction ?? "left-right") as LineDirection,
      lineWidth: params.lineWidth ?? 100,
      lineOpacity: params.lineOpacity ?? 100,
      posType: (params.posType ?? "rect") as PosType,
      lineColor: params.otherColor ?? "#FFFFFF",
      posColor: params.posColor ?? "#FFFFFF",
    });
  } else if (style === "dsj") {
    content = renderDsj(matrix, tt, {
      scale: params.scale ?? 70,
      crossWidth: params.crossWidth ?? 70,
      posWidth: params.posWidth ?? 90,
      posType: params.dsjPosType ?? "dsj",
    });
  } else if (style === "bubble") {
    content = renderBubble(matrix, tt, {
      circleColor: params.circleColor ?? params.otherColor ?? "#8ED1FC",
      posColor: params.posColor ?? "#4DA6FF",
      bgColor,
    });
  } else {
    content = renderFunc(matrix, tt, {
      funcType: params.funcType ?? "A",
      pointType: (params.pointType ?? "rect") as FuncPointType,
      posType: (params.posType ?? "rect") as PosType,
      otherColor1: params.otherColor ?? "#FFFFFF",
      otherColor2: params.otherColor2 ?? "#FFFFFF",
      posColor: params.posColor ?? "#FFFFFF",
      bgColor,
    });
  }

  return { content, viewBox, version, moduleCount: nCount, bgColor };
}

export function wrapQrbtfSvg(r: { content: string; viewBox: string; bgColor: string }, width: number, height: number): string {
  const [vx, vy, vw, vh] = r.viewBox.split(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="${r.viewBox}" shape-rendering="crispEdges"><rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${esc(r.bgColor)}"/>${r.content}</svg>`;
}
