import { describe, it, expect } from "vitest";
import { reduceProjectsState, type Project } from "./useListProjects.js";

const p = (slug: string, assetCount = 0): Project => ({ slug, path: `/projects/${slug}`, asset_count: assetCount });

describe("reduceProjectsState", () => {
  it("adopts parsed when prev is empty", () => {
    const prev: Project[] = [];
    const parsed = [p("inject"), p("nails")];
    expect(reduceProjectsState(prev, parsed)).toBe(parsed);
  });

  it("returns prev (reference-equal) when slugs match in order", () => {
    const prev = [p("inject"), p("nails")];
    const parsed = [p("inject"), p("nails")];
    expect(reduceProjectsState(prev, parsed)).toBe(prev);
  });

  it("adopts parsed when lengths differ", () => {
    const prev = [p("inject")];
    const parsed = [p("inject"), p("nails")];
    expect(reduceProjectsState(prev, parsed)).toBe(parsed);
  });

  it("adopts parsed when a slug differs", () => {
    const prev = [p("inject"), p("nails")];
    const parsed = [p("inject"), p("god")];
    expect(reduceProjectsState(prev, parsed)).toBe(parsed);
  });

  it("adopts parsed when order differs", () => {
    const prev = [p("inject"), p("nails")];
    const parsed = [p("nails"), p("inject")];
    expect(reduceProjectsState(prev, parsed)).toBe(parsed);
  });

  it("adopts parsed when an asset count differs", () => {
    const prev = [p("inject", 0), p("nails", 1)];
    const parsed = [p("inject", 1), p("nails", 1)];
    expect(reduceProjectsState(prev, parsed)).toBe(parsed);
  });

  // Regression: two hook instances share a module-level cache. The previous
  // implementation compared parsed against the shared cache, so a second
  // instance whose local state was still empty would skip the update once the
  // first instance had filled the cache — leaving the dropdown blank.
  it("keeps each instance's state independent of a peer's prior fill", () => {
    const parsed = [p("inject"), p("nails"), p("god")];

    // Instance A starts empty, fetches, adopts parsed.
    const stateA = reduceProjectsState([], parsed);
    expect(stateA).toBe(parsed);

    // Instance B starts empty (its own state) and fetches the same data.
    // Even though a peer already populated the shared cache, B's prev is
    // still [], so it must adopt parsed rather than bail out.
    const stateB = reduceProjectsState([], parsed);
    expect(stateB).toBe(parsed);
    expect(stateB.length).toBe(3);
  });
});
