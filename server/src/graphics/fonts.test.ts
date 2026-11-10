import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BUNDLED_CAPTION_FONTS, remoteCaptionFamilies } from "../captions/fonts.js";
import { captionScripts } from "../captions/script.js";
import type { GraphicsFontPreset } from "./model.js";
import { GRAPHICS_FONT_PRESETS } from "./model.js";
import { graphicsLineMetrics, graphicsPresetFont } from "./fonts.js";

const THAI = "ติดไฟแดงยังไงให้เท่ได้ขนาดนี้";
const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "remotion", "public", "fonts");
const THAI_BLOCK = "U+0E01-0E5B";
const NAMED_TABLES: Readonly<Record<number, string>> = { 1: "head", 2: "hhea", 10: "glyf", 11: "loca" };

type FileMetrics = { unitsPerEm: number; ascender: number; descender: number; yMin: number; yMax: number };

function uintBase128(bytes: Buffer, cursor: { at: number }): number {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    const byte = bytes[cursor.at];
    cursor.at += 1;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
  }
  throw new Error("Malformed UIntBase128 value");
}

function tableTag(bytes: Buffer, cursor: { at: number }, flags: number): string {
  if ((flags & 0x3f) !== 0x3f) return NAMED_TABLES[flags & 0x3f] ?? `#${flags & 0x3f}`;
  const tag = bytes.toString("latin1", cursor.at, cursor.at + 4);
  cursor.at += 4;
  return tag;
}

function woff2Metrics(file: string): FileMetrics {
  const bytes = readFileSync(join(FONTS_DIR, file));
  expect(bytes.toString("latin1", 0, 4)).toBe("wOF2");
  const cursor = { at: 48 };
  const tables: Array<{ tag: string; length: number }> = [];
  for (let index = 0; index < bytes.readUInt16BE(12); index += 1) {
    const flags = bytes[cursor.at];
    cursor.at += 1;
    const tag = tableTag(bytes, cursor, flags);
    const length = uintBase128(bytes, cursor);
    const transformed = tag === "glyf" || tag === "loca" ? flags >> 6 === 0 : flags >> 6 !== 0;
    tables.push({ tag, length: transformed ? uintBase128(bytes, cursor) : length });
  }
  const data = brotliDecompressSync(bytes.subarray(cursor.at, cursor.at + bytes.readUInt32BE(20)));
  const table = (tag: string): Buffer => {
    const index = tables.findIndex((entry) => entry.tag === tag);
    const offset = tables.slice(0, index).reduce((sum, entry) => sum + entry.length, 0);
    return data.subarray(offset, offset + tables[index].length);
  };
  const head = table("head");
  const hhea = table("hhea");
  return { unitsPerEm: head.readUInt16BE(18), yMin: head.readInt16BE(38), yMax: head.readInt16BE(42), ascender: hhea.readInt16BE(4), descender: hhea.readInt16BE(6) };
}

function familyMetrics(family: string): { ascent: number; descent: number } {
  const values = BUNDLED_CAPTION_FONTS
    .filter((font) => font.family === family)
    .map((font) => woff2Metrics(font.file))
    .map((metrics) => ({ ascent: metrics.ascender / metrics.unitsPerEm, descent: -metrics.descender / metrics.unitsPerEm }));
  expect(values.length).toBeGreaterThan(0);
  expect(new Set(values.map((value) => JSON.stringify(value))).size).toBe(1);
  return values[0];
}

function stackFamilies(preset: GraphicsFontPreset): string[] {
  return graphicsPresetFont(preset).family.split(",").map((name) => name.trim().replace(/^"|"$/gu, "")).filter((name) => name !== "sans-serif");
}

describe("graphics font presets", () => {
  it("names each preset's family first, then the Thai-capable family, then the system sans", () => {
    expect(graphicsPresetFont("heavy")).toEqual({ family: "\"Montserrat\", \"Noto Sans Thai\", sans-serif", weight: 800 });
    expect(graphicsPresetFont("display")).toEqual({ family: "\"Anton\", \"Noto Sans Thai\", sans-serif", weight: 400 });
    expect(graphicsPresetFont("text")).toEqual({ family: "\"Noto Sans Thai\", sans-serif", weight: 500 });
  });

  it("takes line metrics from the preset's font, and from the Thai family too once the text holds Thai", () => {
    expect(graphicsLineMetrics("heavy", "Red light")).toEqual({ ascent: 0.968, descent: 0.251 });
    expect(graphicsLineMetrics("heavy", `${THAI} 2026`)).toEqual({ ascent: 1.061, descent: 0.45 });
    expect(graphicsLineMetrics("display", "RED LIGHT")).toEqual({ ascent: 2409 / 2048, descent: 674 / 2048 });
    expect(graphicsLineMetrics("display", THAI)).toEqual({ ascent: 2409 / 2048, descent: 0.45 });
    expect(graphicsLineMetrics("text", "Red light")).toEqual({ ascent: 1.061, descent: 0.45 });
  });

  it.each(GRAPHICS_FONT_PRESETS)("lists only families bundled at the %s preset's weight", (preset) => {
    const { weight } = graphicsPresetFont(preset);
    for (const family of stackFamilies(preset)) {
      expect(BUNDLED_CAPTION_FONTS.some((font) => font.family === family && font.weight === weight), `${family} ${weight}`).toBe(true);
    }
  });

  it("draws Thai from bundled faces at every preset weight without a remote font", () => {
    expect(remoteCaptionFamilies(captionScripts(THAI))).toEqual([]);
    expect(remoteCaptionFamilies(captionScripts("Привет"))).toEqual(["Noto Sans"]);
    for (const preset of GRAPHICS_FONT_PRESETS) {
      const { weight } = graphicsPresetFont(preset);
      const thaiFaces = BUNDLED_CAPTION_FONTS.filter((font) => font.family === "Noto Sans Thai" && font.weight === weight && font.unicodeRange.includes(THAI_BLOCK));
      expect(thaiFaces, preset).toHaveLength(1);
    }
    expect(BUNDLED_CAPTION_FONTS.find((font) => font.family === "Noto Sans Thai" && font.weight === 400)?.file).toBe("noto-sans-thai-800-thai.woff2");
  });

  it("keeps every bundled file a woff2 next to its family's licence", () => {
    for (const font of BUNDLED_CAPTION_FONTS) {
      expect(woff2Metrics(font.file).unitsPerEm).toBeGreaterThan(0);
      expect(existsSync(join(FONTS_DIR, `OFL-${font.family.replace(/ /gu, "")}.txt`)), font.family).toBe(true);
    }
  });

  it("matches the line metrics to the bundled files and keeps Thai marks inside them", () => {
    const montserrat = familyMetrics("Montserrat");
    const anton = familyMetrics("Anton");
    const thai = familyMetrics("Noto Sans Thai");
    const widest = (a: typeof thai, b: typeof thai) => ({ ascent: Math.max(a.ascent, b.ascent), descent: Math.max(a.descent, b.descent) });
    const cases: Array<[GraphicsFontPreset, string, { ascent: number; descent: number }]> = [
      ["heavy", "Red light", montserrat],
      ["heavy", THAI, widest(montserrat, thai)],
      ["display", "RED LIGHT", anton],
      ["display", THAI, widest(anton, thai)],
      ["text", "Red light", thai],
    ];
    for (const [preset, text, expected] of cases) {
      const metrics = graphicsLineMetrics(preset, text);
      expect(metrics.ascent).toBeCloseTo(expected.ascent, 10);
      expect(metrics.descent).toBeCloseTo(expected.descent, 10);
    }
    for (const font of BUNDLED_CAPTION_FONTS.filter((candidate) => candidate.family === "Noto Sans Thai" && candidate.unicodeRange.includes(THAI_BLOCK))) {
      const metrics = woff2Metrics(font.file);
      expect(metrics.yMax / metrics.unitsPerEm, font.file).toBeLessThanOrEqual(thai.ascent);
      expect(-metrics.yMin / metrics.unitsPerEm, font.file).toBeLessThanOrEqual(thai.descent);
    }
  });
});
