import { describe, expect, it } from "vitest";
import { parseHttpByteRange } from "./http-byte-range.js";

describe("parseHttpByteRange", () => {
  it("parses bounded, open, and suffix byte ranges", () => {
    expect(parseHttpByteRange("bytes=10-19", 100)).toEqual({
      ok: true,
      start: 10,
      end: 19,
    });
    expect(parseHttpByteRange("bytes=90-", 100)).toEqual({
      ok: true,
      start: 90,
      end: 99,
    });
    expect(parseHttpByteRange("bytes=-10", 100)).toEqual({
      ok: true,
      start: 90,
      end: 99,
    });
  });

  it("clamps ends and rejects malformed or unsatisfiable ranges", () => {
    expect(parseHttpByteRange("bytes=90-200", 100)).toEqual({
      ok: true,
      start: 90,
      end: 99,
    });
    expect(parseHttpByteRange("bytes=100-", 100)).toEqual({ ok: false });
    expect(parseHttpByteRange("bytes=20-10", 100)).toEqual({ ok: false });
    expect(parseHttpByteRange("bytes=0-1,4-5", 100)).toEqual({ ok: false });
    expect(parseHttpByteRange("items=0-1", 100)).toEqual({ ok: false });
  });
});
