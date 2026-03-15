import { describe, it, expect } from "vitest";
import { parseTime } from "./time-parse.js";

describe("parseTime", () => {
  it("returns undefined for undefined input", () => {
    expect(parseTime(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseTime("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(parseTime("   ")).toBeUndefined();
  });

  it("returns the same number for numeric input", () => {
    expect(parseTime(42)).toBe(42);
    expect(parseTime(0)).toBe(0);
    expect(parseTime(3.5)).toBe(3.5);
  });

  it("parses bare numeric strings", () => {
    expect(parseTime("90")).toBe(90);
    expect(parseTime("5")).toBe(5);
    expect(parseTime("3.5")).toBe(3.5);
  });

  it("parses '0' as 0", () => {
    expect(parseTime("0")).toBe(0);
  });

  it("parses two-part colon format as mm:ss", () => {
    expect(parseTime("1:30")).toBe(90);
    expect(parseTime("0:05")).toBe(5);
    expect(parseTime("2:00")).toBe(120);
    expect(parseTime("10:30")).toBe(630);
  });

  it("parses three-part colon format as hh:mm:ss", () => {
    expect(parseTime("1:30:00")).toBe(5400);
    expect(parseTime("0:01:30")).toBe(90);
    expect(parseTime("1:00:00")).toBe(3600);
    expect(parseTime("2:30:15")).toBe(9015);
  });

  it("parses colon format with suffix", () => {
    expect(parseTime("1:30 seconds")).toBe(90);
    expect(parseTime("1:30 sec")).toBe(90);
    expect(parseTime("1:30 s")).toBe(90);
  });

  it("parses shorthand with hours", () => {
    expect(parseTime("1h")).toBe(3600);
    expect(parseTime("2h")).toBe(7200);
  });

  it("parses shorthand with minutes", () => {
    expect(parseTime("5m")).toBe(300);
    expect(parseTime("1min")).toBe(60);
  });

  it("parses shorthand with seconds", () => {
    expect(parseTime("30s")).toBe(30);
    expect(parseTime("45sec")).toBe(45);
  });

  it("parses combined shorthand", () => {
    expect(parseTime("2m20s")).toBe(140);
    expect(parseTime("1h30m")).toBe(5400);
    expect(parseTime("1h2m3s")).toBe(3723);
  });

  it("throws Error for invalid strings", () => {
    expect(() => parseTime("abc")).toThrow(Error);
    expect(() => parseTime("not a time")).toThrow("Cannot parse timestamp");
    expect(() => parseTime("::")).toThrow(Error);
  });
});
