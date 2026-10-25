import { describe, expect, it } from "vitest";
import { testBudget, testTimeScale, testWorkers } from "./test-budget.js";

const host = (cores: number, load: number) => ({ cores, load });

describe("test budget policy", () => {
  it("keeps today's local worker default on an idle host and sheds two workers per full core multiple of load", () => {
    expect(testWorkers({}, host(12, 1))).toBe(8);
    expect(testWorkers({}, host(12, 23.9))).toBe(8);
    expect(testWorkers({}, host(12, 30))).toBe(6);
    expect(testWorkers({}, host(12, 40))).toBe(4);
    expect(testWorkers({}, host(12, 80))).toBe(2);
    expect(testWorkers({}, host(8, 0))).toBe(6);
    expect(testWorkers({}, host(4, 0))).toBe(2);
  });

  it("scales budgets by the host's runnable tasks per core, from 1 on an idle host up to a cap", () => {
    expect(testTimeScale({}, host(12, 1))).toBe(1);
    expect(testTimeScale({}, host(12, 30))).toBe(3);
    expect(testTimeScale({}, host(12, 40))).toBe(3.67);
    expect(testTimeScale({}, host(12, 200))).toBe(6);
  });

  it("pins GitHub Actions to two workers and unscaled budgets", () => {
    const env = { GITHUB_ACTIONS: "true" };
    expect(testWorkers(env, host(4, 9))).toBe(2);
    expect(testTimeScale(env, host(4, 9))).toBe(1);
  });

  it("honors explicit worker and scale overrides and ignores unusable ones", () => {
    const env = { GITHUB_ACTIONS: "true", VIDEOBOOK_TEST_WORKERS: "3", VIDEOBOOK_TEST_TIME_SCALE: "2.5" };
    expect(testWorkers(env, host(12, 30))).toBe(3);
    expect(testTimeScale(env, host(12, 30))).toBe(2.5);
    expect(testTimeScale({ VIDEOBOOK_TEST_WORKERS: "2" }, host(12, 30))).toBe(2.67);
    for (const value of ["", "0", "-1", "fast"]) {
      expect(testWorkers({ VIDEOBOOK_TEST_WORKERS: value }, host(12, 30))).toBe(6);
      expect(testTimeScale({ VIDEOBOOK_TEST_TIME_SCALE: value }, host(12, 30))).toBe(3);
    }
  });

  it("rounds scaled budgets up to whole milliseconds", () => {
    expect(testBudget(15_000, 1)).toBe(15_000);
    expect(testBudget(1_001, 1.5)).toBe(1_502);
  });

  it("gives every test worker the run's single scale factor", () => {
    const shared = process.env.VIDEOBOOK_TEST_TIME_SCALE;
    expect(Number(shared)).toBeGreaterThan(0);
    expect(testTimeScale()).toBe(Number(shared));
    expect(testBudget(30_000)).toBe(Math.ceil(30_000 * Number(shared)));
  });
});
