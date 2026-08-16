import { describe, expect, it } from "vitest";
import { decodeOccupiedRegionsResponse } from "./vision-regions.js";

function response(frames: unknown[]): string {
  return JSON.stringify({ frames });
}

function frame(cueId: string, occupiedRegions: unknown[]): Record<string, unknown> {
  return {
    cue_id: cueId,
    occupied_regions: occupiedRegions,
  };
}

function region(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "face",
    confidence: 0.8,
    x: 0,
    y: 250,
    width: 1000,
    height: 750,
    ...overrides,
  };
}

describe("decodeOccupiedRegionsResponse", () => {
  it("normalizes model coordinates from 0..1000 to 0..1", () => {
    const decoded = decodeOccupiedRegionsResponse(
      response([
        frame("cue-a", [
          region(),
          region({
            kind: "text",
            confidence: 0.4,
            x: 125,
            y: 500,
            width: 375,
            height: 250,
          }),
        ]),
        frame("cue-b", []),
      ]),
      ["cue-a", "cue-b"],
      "Keyword placement",
    );

    expect(decoded).toEqual(new Map([
      ["cue-a", [
        {
          kind: "face",
          confidence: 0.8,
          x: 0,
          y: 0.25,
          width: 1,
          height: 0.75,
        },
        {
          kind: "text",
          confidence: 0.4,
          x: 0.125,
          y: 0.5,
          width: 0.375,
          height: 0.25,
        },
      ]],
      ["cue-b", []],
    ]));
  });

  it("rejects duplicate cue IDs", () => {
    expect(() => decodeOccupiedRegionsResponse(
      response([
        frame("cue-a", []),
        frame("cue-a", []),
      ]),
      ["cue-a", "cue-b"],
      "Keyword placement",
    )).toThrow("Keyword placement vision response did not contain exactly one result per cue");
  });

  it("rejects missing cue IDs", () => {
    expect(() => decodeOccupiedRegionsResponse(
      response([frame("cue-a", [])]),
      ["cue-a", "cue-b"],
      "Watermark placement",
    )).toThrow("Watermark placement vision response did not contain exactly one result per cue");
  });

  it("rejects malformed JSON", () => {
    expect(() => decodeOccupiedRegionsResponse(
      "{not-json",
      ["cue-a"],
      "Keyword placement",
    )).toThrow("Keyword placement vision response was invalid");
  });

  it.each([
    ["right edge", { x: 900, width: 101 }],
    ["bottom edge", { y: 900, height: 101 }],
  ])("rejects a box outside the %s", (_label, overrides) => {
    expect(() => decodeOccupiedRegionsResponse(
      response([frame("cue-a", [region(overrides)])]),
      ["cue-a"],
      "Keyword placement",
    )).toThrow("occupied region extends beyond the frame");
  });

  it.each([
    ["negative origin", { x: -1 }],
    ["zero width", { width: 0 }],
    ["invalid confidence", { confidence: 1.1 }],
    ["invalid kind", { kind: "person" }],
  ])("rejects an invalid box with %s", (_label, overrides) => {
    expect(() => decodeOccupiedRegionsResponse(
      response([frame("cue-a", [region(overrides)])]),
      ["cue-a"],
      "Keyword placement",
    )).toThrow("Keyword placement vision response was invalid");
  });
});
