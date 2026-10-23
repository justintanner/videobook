import { FRONTIER, FRONTIER_TYPES, formatFrontierPrice, frontier } from "@apicity/cost";
import type { FrontierRow, FrontierType } from "@apicity/cost";
import { MODEL_ENTRIES } from "./catalog.js";

export interface ModelFrontierRanking {
  type: FrontierType;
  rank: number;
  elo: number;
  priceLabel: string;
  sourceUrl: string;
  capturedOn: string;
}

export function frontierCatalogId(row: FrontierRow): string | null {
  const endpoint = FRONTIER[row.type].entries.find((entry) => entry.rank === row.rank && entry.model === row.model)?.endpoints
    .find((endpoint) => endpoint.provider === row.provider && endpoint.dotPath === row.dotPath && endpoint.modelId === row.modelId);
  const apiId = row.modelId ?? (row.provider === "fal" ? endpoint?.pricingKey : undefined);
  return apiId && apiId !== "unpriced" ? `${row.provider}:${apiId}` : null;
}

const rankings = new Map<string, ModelFrontierRanking[]>();
for (const { type } of FRONTIER_TYPES) {
  for (const row of frontier(type)) {
    const id = frontierCatalogId(row);
    if (!id || !MODEL_ENTRIES.some((entry) => entry.id === id)) continue;
    const previous = rankings.get(id) ?? [];
    if (previous.some((entry) => entry.type === type)) continue;
    rankings.set(id, [...previous, {
      type,
      rank: row.rank,
      elo: row.elo,
      priceLabel: formatFrontierPrice(row.price),
      sourceUrl: FRONTIER[type].sourceUrl,
      capturedOn: FRONTIER[type].capturedOn,
    }]);
  }
}

export function modelFrontierRankings(id: string): readonly ModelFrontierRanking[] {
  return rankings.get(id) ?? [];
}
