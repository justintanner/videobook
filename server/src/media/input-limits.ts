import type { InputLimit, InputLimitBound, RefRole } from "./types.js";

export type InputCounts = Partial<Record<RefRole, number>>;

type InputLimitOptions = Readonly<Record<string, unknown>>;

function boundValue(bound: InputLimitBound, options: InputLimitOptions): number | null {
  if (typeof bound === "number") return bound;
  const value = Number(options[bound.option]);
  return Number.isFinite(value) ? Math.min(value + bound.offset, bound.cap) : null;
}

export function inputLimitCap(limit: InputLimit, options: InputLimitOptions): number | null {
  if (limit.kind !== "max") return null;
  if (limit.when && options[limit.when.option] !== limit.when.equals) return null;
  return boundValue(limit.max, options);
}

function maxViolated(limit: Extract<InputLimit, { kind: "max" }>, counts: InputCounts, options: InputLimitOptions): boolean {
  const cap = inputLimitCap(limit, options);
  if (cap === null) return false;
  const total = limit.roles.reduce((sum, entry) => sum + (counts[entry.role] ?? 0) * (entry.weight ?? 1), 0);
  return total > cap;
}

export function inputLimitViolations(
  limits: readonly InputLimit[],
  counts: InputCounts,
  options: InputLimitOptions,
): string[] {
  return limits.flatMap((limit) => {
    if (limit.kind === "requires") {
      return (counts[limit.role] ?? 0) > 0 && (counts[limit.requires] ?? 0) === 0 ? [limit.message] : [];
    }
    return maxViolated(limit, counts, options) ? [limit.message] : [];
  });
}
