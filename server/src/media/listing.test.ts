import { afterEach, describe, expect, it } from "vitest";
import { diagnosticRecord } from "../diagnostics.js";
import { configureLoggerForTests, resetLoggerForTests } from "../logger.js";
import { MODEL_ENTRIES } from "./catalog.js";
import { listModels, resolvableModels } from "./listing.js";
import type { ModelEntry } from "./types.js";

const UNRESOLVABLE: ModelEntry = {
  id: "kie:videobook-listing-probe/text-to-video",
  media: "video",
  operations: ["text_to_video"],
};

function capture(): string[] {
  const lines: string[] = [];
  const collect = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  configureLoggerForTests({ level: "debug", sink: { error: collect, warn: collect, info: collect, debug: collect } });
  return lines;
}

describe("model listing", () => {
  afterEach(() => {
    resetLoggerForTests();
  });

  it("skips a model apicity cannot describe and keeps the rest of the catalog", () => {
    const lines = capture();
    const known = MODEL_ENTRIES[0]!;
    const models = resolvableModels([known, UNRESOLVABLE]);
    expect(models.map((model) => model.id)).toEqual([known.id]);
    resolvableModels([UNRESOLVABLE]);
    expect(lines).toEqual([
      `[model-unresolvable] ${JSON.stringify({ event: "model-unresolvable", errorCode: "UNKNOWN" })}`,
    ]);
  });

  it("names a catalog model in the diagnostic and drops ids outside the catalog", () => {
    const known = MODEL_ENTRIES[0]!.id;
    expect(diagnosticRecord("model-unresolvable", { model: known })).toEqual({ event: "model-unresolvable", model: known });
    expect(diagnosticRecord("model-unresolvable", { model: UNRESOLVABLE.id })).toEqual({ event: "model-unresolvable" });
  });

  it("lists every catalog model when all of them resolve", () => {
    expect(listModels({ includeHidden: true })).toHaveLength(MODEL_ENTRIES.length);
  });
});
