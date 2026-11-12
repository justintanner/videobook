import type { Engine } from "videobook-engine";
import { z } from "zod";
import { requireApiKey } from "../api-key.js";
import { chatIntelligenceRequestOptions } from "../chat-models.js";
import { readGoal, requireGoalShortContent } from "../goal-store.js";
import { shortPlannerBrief, shortRevisionInstructions, shortRevisionIssues, shortRevisionPart, shortRevisionResponseSchema, type ShortPlannerIssue } from "../goal-short-planner.js";
import { shortRulesOutPhone, shortWantsPhone, stripShortBannedWords, withoutShortPhoneSentences } from "../goal-short-rules.js";
import { buildIntelligenceResponses, firstResponseText, intelligenceRequest } from "../openai-intelligence.js";
import { registerJobHandler } from "../queue.js";

type RevisePayload = { goalId: string; stage: "frame" | "videos"; index: number; feedback: string; revision: number };

const answerSchema = z.object({ prompt: z.string() });

function revisedPrompt(text: string): string | null {
  try {
    const parsed = answerSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.prompt.trim() : null;
  } catch {
    return null;
  }
}

async function reviseShortPrompt(engine: Engine, payload: RevisePayload, signal: AbortSignal): Promise<{ prompt: string }> {
  const goal = readGoal(engine, payload.goalId);
  const content = requireGoalShortContent(engine, goal);
  if (!content.plan || content.revision !== payload.revision) throw new Error("The goal changed. Review the current version before revising it.");
  const { plan } = content;
  const part = shortRevisionPart(plan, payload.stage, payload.index);
  const phones = !shortRulesOutPhone(payload.feedback) && [content.brief, part.prompt, payload.feedback].some(shortWantsPhone);
  const notebook = engine.notebooks.read(goal.notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  const context = payload.stage === "frame"
    ? { next: plan.segments[0]?.prompt ?? null }
    : { previous: payload.index === 0 ? plan.frame.prompt : plan.segments[payload.index - 1]!.prompt, next: plan.segments[payload.index + 1]?.prompt ?? null };
  const options = chatIntelligenceRequestOptions();
  const responses = buildIntelligenceResponses(requireApiKey("OPENAI_API_KEY"), options);
  const request = {
    instructions: await shortRevisionInstructions(plan, payload.stage, payload.index),
    input: [{ role: "user" as const, content: JSON.stringify({
      brief: shortPlannerBrief(content.brief, [...plan.character.references, ...plan.frame.references], notebook.value),
      character: { name: plan.character.name, description: plan.character.description },
      aspectRatio: plan.aspectRatio,
      revise: part.name,
      prompt: part.prompt,
      ...context,
      feedback: payload.feedback,
    }) }],
    text: { format: { type: "json_schema" as const, name: "short_revision", strict: true, schema: z.toJSONSchema(shortRevisionResponseSchema(part)) } },
    max_output_tokens: 1000,
  };
  const first = revisedPrompt(firstResponseText(await responses(intelligenceRequest(request, options), signal)));
  const issues: ShortPlannerIssue[] = first === null
    ? [{ kind: "empty", message: `Answer with JSON holding the whole revised ${part.name}.` }]
    : shortRevisionIssues(first, part, phones);
  if (first !== null && issues.length === 0) return { prompt: first };
  const second = revisedPrompt(firstResponseText(await responses(intelligenceRequest({
    ...request,
    input: [...request.input, {
      role: "user" as const,
      content: `Fix these problems and answer again with the whole revised ${part.name}: ${issues.map((issue) => issue.message).join(" ")}${first === null ? "" : `\nYour previous answer: ${JSON.stringify({ prompt: first })}`}`,
    }],
  }, options), signal)));
  const again = `Revise the ${part.name} again, or edit it and regenerate.`;
  if (second === null) throw new Error(`The rewrite of the ${part.name} did not answer with a prompt. ${again}`);
  const blocking = shortRevisionIssues(second, part, phones).filter((issue) => issue.kind !== "banned" && issue.kind !== "phone");
  if (blocking.length > 0) throw new Error(`The rewritten ${part.name} still breaks its limits. ${blocking.map((issue) => issue.message).join(" ")} ${again}`);
  const cleaned = stripShortBannedWords(second);
  const prompt = (phones ? cleaned : withoutShortPhoneSentences(cleaned)).trim();
  if (!prompt) throw new Error(`The rewritten ${part.name} was empty without its banned words or phone sentences. ${again}`);
  return { prompt };
}

export function registerReviseGoalPromptJob(engine: Engine): void {
  registerJobHandler("revise_goal_prompt", (payload, context) => reviseShortPrompt(engine, payload as unknown as RevisePayload, context.signal));
}
