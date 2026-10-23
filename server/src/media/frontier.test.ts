import { describe, expect, it } from "vitest";
import { FRONTIER_TYPES, frontier, formatFrontierPrice } from "@apicity/cost";
import { MODEL_ENTRIES } from "./catalog.js";
import { frontierCatalogId, modelFrontierRankings } from "./frontier.js";
import { FRONTIER_CATALOG_GAPS } from "./frontier-gaps.js";
import { listModels, modelListing } from "./listing.js";
import { PROVIDER_ENV_KEYS } from "./adapters/index.js";

const rows = FRONTIER_TYPES.flatMap(({ type }) => frontier(type));

describe("frontier catalog coverage", () => {
  it("maps every endpoint exactly or records an explicit gap", () => {
    const missing = rows.filter((row) => !MODEL_ENTRIES.some((entry) => entry.id === frontierCatalogId(row)));
    expect([...new Set(missing.map((row) => `${row.provider}:${row.modelId ?? row.dotPath}`))].sort())
      .toEqual(Object.keys(FRONTIER_CATALOG_GAPS).sort());
    for (const row of rows) {
      const id = frontierCatalogId(row);
      if (!id || !MODEL_ENTRIES.some((entry) => entry.id === id)) continue;
      expect(modelFrontierRankings(id)).toContainEqual(expect.objectContaining({
        type: row.type, rank: row.rank, elo: row.elo, priceLabel: formatFrontierPrice(row.price),
      }));
    }
  });

  it("keeps independent ranks for multi-operation models and never ranks a different model version", () => {
    expect(modelFrontierRankings("machgen:MiniMax-H3")).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "t2v", rank: 4 }),
      expect.objectContaining({ type: "i2v", rank: 1 }),
    ]));
    expect(modelFrontierRankings("xai:grok-imagine-video")).toEqual([]);
    expect(modelFrontierRankings("fal:xai/grok-imagine-video/v1.5/lite/image-to-video")).toEqual([]);
  });

  it("includes catalog frontier variants even when previously hidden", () => {
    const models = listModels();
    expect(models.some((model) => model.id === "fal:google/nano-banana-2.1")).toBe(true);
    expect(models.some((model) => model.id === "kie:gpt-image-2-image-to-image")).toBe(true);
    expect(models.some((model) => model.id === "fal:fal-ai/nano-banana")).toBe(false);
    expect(modelListing(models.find((model) => model.id === "fal:google/nano-banana-2.1")!).hidden).toBe(false);
  });

  it("refreshes availability after provider credentials change", () => {
    const model = listModels().find((model) => model.provider === "machgen")!;
    const previous = process.env.MACHGEN_API_KEY;
    try {
      delete process.env.MACHGEN_API_KEY;
      expect(modelListing(model).available).toBe(false);
      process.env.MACHGEN_API_KEY = "offline-test-key";
      expect(modelListing(model).available).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.MACHGEN_API_KEY;
      else process.env.MACHGEN_API_KEY = previous;
    }
  });

  it("publishes rankings and current credential availability without hiding catalog entries", () => {
    for (const model of listModels()) {
      const listing = modelListing(model);
      expect(listing.available).toBe(Boolean(process.env[PROVIDER_ENV_KEYS[model.provider]]?.trim()));
      expect(listing.frontier).toEqual(modelFrontierRankings(model.id));
    }
  });
});
