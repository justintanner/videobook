import QRCode from "qrcode";
import type { GraphicsQrLayer } from "./model.js";

export type GraphicsQrMatrix = { size: number; dark: boolean[] };

export function qrMatrix(url: string, level: GraphicsQrLayer["level"]): GraphicsQrMatrix {
  const { modules } = QRCode.create(url, { errorCorrectionLevel: level });
  const dark: boolean[] = [];
  for (let row = 0; row < modules.size; row += 1) {
    for (let column = 0; column < modules.size; column += 1) dark.push(modules.get(row, column) === 1);
  }
  return { size: modules.size, dark };
}
