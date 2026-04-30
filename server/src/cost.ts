import { cost } from "@apicity/cost";
import type { CostProvider } from "@apicity/cost";

let cached: CostProvider | null = null;

export function getCostProvider(): CostProvider {
  if (cached) return cached;
  const opts: Parameters<typeof cost>[0] = {};
  if (process.env.OPENAI_API_KEY) opts.openai = { apiKey: process.env.OPENAI_API_KEY };
  if (process.env.ANTHROPIC_API_KEY) opts.anthropic = { apiKey: process.env.ANTHROPIC_API_KEY };
  if (process.env.XAI_API_KEY) opts.xai = { apiKey: process.env.XAI_API_KEY };
  if (process.env.KIMI_CODING_API_KEY) opts.kimicoding = { apiKey: process.env.KIMI_CODING_API_KEY };
  if (process.env.FAL_API_KEY) opts.fal = { apiKey: process.env.FAL_API_KEY };
  cached = cost(opts);
  return cached;
}
