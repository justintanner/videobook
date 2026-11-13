import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "../engine.js";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { goalTestCharacters } from "../test-goals.js";
import { testBudget } from "../test-budget.js";
import { shortTiming, SHORT_WORD_CEILINGS, type GoalShortDraft } from "../goal-short-plan.js";
import { SHORT_AVOID, SHORT_RULES, shortBannedWords } from "../goal-short-rules.js";
import { loadGuide } from "../tools/rewrite-prompt.js";
import {
  createGoalShortCell, emptyGoalEstimates, readGoal, readGoalCell, requireGoalShortContent, saveGoal, type GoalRecord,
} from "../goal-store.js";

type ModelRequest = {
  instructions: string;
  input: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: string }> }>;
  text: { format: { schema: { properties: { beats: { minItems: number; maxItems: number } } } } };
};

const words = (count: number) => Array.from({ length: count }, (_, index) => `step${index}`).join(" ");
const PLAN = {
  title: "Waiting for the bus",
  frame: "He stands under a bus shelter at dusk, rain on the road, holding a folded umbrella.",
  beats: ["He checks the road for the bus, then wipes rain from his sleeve.", "He steps back from a splash and boards the bus."],
};

function responsesBody(text: string): string {
  return JSON.stringify({
    id: "resp_short_plan", object: "response", created_at: 0, status: "completed", model: "gpt-6-astra",
    output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    instructions: null, previous_response_id: null, temperature: null, top_p: null, max_output_tokens: null,
    store: false, tools: [], reasoning: null, text: { format: { type: "text" } },
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 }, error: null, incomplete_details: null, metadata: {},
  });
}

describe("plan_goal for a short", () => {
  let server: Server;
  let requests: ModelRequest[];
  let answers: unknown[];
  let root: string;
  let engine: Engine;
  let client: Client;
  let notebookId: string;
  let imageIds: string[];
  let restoreEndpoints: () => void;
  let savedKey: string | undefined;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelRequest);
        const answer = answers.shift();
        response.writeHead(answer === undefined ? 500 : 200, { "content-type": "application/json" });
        response.end(answer === undefined ? JSON.stringify({ error: { message: "no answer queued" } }) : responsesBody(JSON.stringify(answer)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    requests = [];
    answers = [];
    savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "offline-openai-key";
    restoreEndpoints = configureProviderEndpoints({ openaiBaseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    root = await mkdtemp(join(tmpdir(), "videobook-plan-short-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    const notebook = await engine.notebooks.create("Shorts");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    imageIds = await goalTestCharacters(engine, notebookId);
  });

  afterEach(async () => {
    await client.close();
    restoreEndpoints();
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function reference(index: number) {
    const manifest = await engine.files.manifest(imageIds[index]!);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const cell = notebook.value.cells.find((candidate) => candidate.outputArtifactId === imageIds[index])!;
    return {
      kind: "image" as const, artifactId: imageIds[index]!, cellId: cell.id, address: `@a${index + 1}`,
      label: `Character ${index + 1}`, objectHash: manifest.value.files[0]!.objectHash,
    };
  }

  async function plannedShort(brief: string): Promise<GoalRecord> {
    const timing = shortTiming(brief);
    const draft: GoalShortDraft = {
      aspectRatio: timing.aspectRatio,
      segmentSeconds: timing.segmentSeconds,
      character: { name: "Main character", description: "a man in a green shirt", references: [await reference(0)] },
      extraReferences: [await reference(1)],
    };
    const goalId = uuidv7();
    const cell = await createGoalShortCell(engine, notebookId, goalId, { brief, revision: 1, draft, plan: null, estimate: emptyGoalEstimates(), notes: [] });
    const timestamp = new Date().toISOString();
    const goal = saveGoal(engine, {
      goalId, bookId: engine.book.get().bookId, notebookId, cellId: cell.id, requestId: goalId, status: "planning", planVersion: 4,
      stage: "frame", stages: {}, chainId: null, planningJobId: null, clipIds: [], trackId: null, assembly: null, error: null,
      dismissedAt: null, createdAt: timestamp, updatedAt: timestamp,
    });
    return goal;
  }

  async function plan(goal: GoalRecord): Promise<GoalRecord> {
    await queue.enqueue(`plan-short-${goal.goalId}`, { type: "plan_goal", bookId: goal.bookId, goalId: goal.goalId });
    await expect.poll(() => readGoal(engine, goal.goalId).status, { timeout: testBudget(30_000) }).not.toBe("planning");
    return readGoal(engine, goal.goalId);
  }

  const userText = (request: ModelRequest) => {
    const content = request.input[0]!.content;
    return JSON.parse((content as Array<{ type: string; text?: string }>)[0]!.text!) as Record<string, unknown>;
  };

  it("plans a 20 second brief with one request carrying the rule lines, the avoid list and both guides", async () => {
    answers = [PLAN];
    const goal = await plan(await plannedShort("he waits for a bus in the rain under @a2, 20 seconds"));
    expect(goal).toMatchObject({ status: "review", stage: "frame", error: null });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    for (const line of [...Object.values(SHORT_RULES), ...SHORT_AVOID]) expect(request!.instructions).toContain(line);
    expect(request!.instructions).toContain((await loadGuide("minimax_h3")).trim());
    expect(request!.instructions).toContain((await loadGuide("gpt_image_26")).trim());
    expect(request!.text.format.schema.properties.beats).toMatchObject({ minItems: 2, maxItems: 2 });
    expect(userText(request!)).toMatchObject({
      brief: "he waits for a bus in the rain under Reference 2, 20 seconds",
      character: { name: "Main character", description: "a man in a green shirt" },
      aspectRatio: "9:16",
      segments: [{ beat: 1, seconds: 10 }, { beat: 2, seconds: 10 }],
      fixed: {},
      write: ["title", "frame", "beat 1", "beat 2"],
    });
    const content = request!.input[0]!.content as Array<{ type: string; text?: string }>;
    expect(content.filter((part) => part.type === "input_image")).toHaveLength(2);
    expect(content.filter((part) => part.type === "input_text").map((part) => part.text).slice(1)).toEqual(["Reference 1: Character 1", "Reference 2: Character 2"]);
    const saved = requireGoalShortContent(engine, goal);
    expect(saved.revision).toBe(2);
    expect(saved.plan).toMatchObject({
      version: 4, title: PLAN.title, aspectRatio: "9:16",
      character: { name: "Main character", references: [{ artifactId: imageIds[0], slot: "@image1" }] },
      frame: { prompt: PLAN.frame, references: [{ artifactId: imageIds[1], slot: "@image2" }] },
      segments: [{ prompt: PLAN.beats[0], seconds: 10 }, { prompt: PLAN.beats[1], seconds: 10 }],
      rules: SHORT_RULES,
    });
    expect(saved.plan!.frame.prompt.split(/\s+/u).length).toBeLessThanOrEqual(SHORT_WORD_CEILINGS.frame);
    for (const segment of saved.plan!.segments) expect(segment.prompt.split(/\s+/u).length).toBeLessThanOrEqual(SHORT_WORD_CEILINGS.beat);
    expect(readGoalCell(engine, goal)?.label).toBe(PLAN.title);
  });

  it.each([
    ["a banned word", { ...PLAN, frame: "A cinematic shot of him under a bus shelter at dusk." }, 'Remove "cinematic" from the frame.'],
    ["a beat over 45 words", { ...PLAN, beats: [words(46), PLAN.beats[1]] }, "Shorten the beat 1 to at most 45 words; it has 46."],
  ])("re-asks exactly once after a first answer with %s", async (_name, first, issue) => {
    answers = [first, PLAN];
    const goal = await plan(await plannedShort("he waits for a bus, 20 seconds"));
    expect(goal.status).toBe("review");
    expect(requests).toHaveLength(2);
    const retry = requests[1]!.input.at(-1)!;
    expect(retry.role).toBe("user");
    expect(retry.content).toContain(issue);
    expect(requireGoalShortContent(engine, goal).plan?.frame.prompt).toBe(PLAN.frame);
  });

  it("re-asks once when a planner beat names a phone the brief never asked for, and drops a phone sentence the second answer keeps", async () => {
    const phoned = { ...PLAN, beats: ["He checks the road for the bus. The phone stays at chest height, keeping him framed.", PLAN.beats[1]] };
    answers = [phoned, phoned];
    const goal = await plan(await plannedShort("he waits for a bus in the rain, 20 seconds"));
    expect(requests).toHaveLength(2);
    expect(requests[1]!.input.at(-1)!.content).toContain("Leave the phone out of the beat 1: call it the camera, which someone off screen holds.");
    expect(goal).toMatchObject({ status: "review", error: null });
    expect(requireGoalShortContent(engine, goal).plan!.segments.map((segment) => segment.prompt)).toEqual(["He checks the road for the bus.", PLAN.beats[1]]);
  });

  it("lets the planner give him a phone when the brief does", async () => {
    answers = [{ ...PLAN, beats: ["He checks his phone for the bus time.", PLAN.beats[1]] }];
    const goal = await plan(await plannedShort("he checks his phone at a bus stop, 20 seconds"));
    expect(requests).toHaveLength(1);
    expect(requireGoalShortContent(engine, goal).plan!.segments[0]!.prompt).toBe("He checks his phone for the bus time.");
  });

  it("fails the goal when the second answer is still over a ceiling", async () => {
    answers = [{ ...PLAN, beats: [words(46), PLAN.beats[1]] }, { ...PLAN, beats: [words(50), PLAN.beats[1]] }];
    const goal = await plan(await plannedShort("he waits for a bus, 20 seconds"));
    expect(requests).toHaveLength(2);
    expect(goal.status).toBe("failed");
    expect(goal.error).toBe("The planner's plan still breaks its limits. Shorten the beat 1 to at most 45 words; it has 50. Try planning again.");
    expect(requireGoalShortContent(engine, goal).plan).toBeNull();
  });

  it("saves a second answer with its banned words removed", async () => {
    answers = [
      { ...PLAN, frame: "A cinematic shot of him at the bus stop." },
      { ...PLAN, frame: "A stunning, cinematic photo of him at the bus stop, 8k.", beats: ["He checks the epic road.", PLAN.beats[1]] },
    ];
    const goal = await plan(await plannedShort("he waits for a bus, 20 seconds"));
    expect(requests).toHaveLength(2);
    expect(goal.status).toBe("review");
    const saved = requireGoalShortContent(engine, goal).plan!;
    expect(saved.frame.prompt).toBe("A photo of him at the bus stop.");
    expect(saved.segments[0]!.prompt).toBe("He checks the road.");
    expect(shortBannedWords(JSON.stringify(saved.frame) + JSON.stringify(saved.segments))).toEqual([]);
  });

  it("keeps an authored frame and beat 1 verbatim and asks only for the missing parts", async () => {
    const brief = 'he waits for a bus, 20 seconds. frame: "A cinematic bus shelter at dusk." beat 1: "He checks the road twice."';
    answers = [{ title: "Waiting for the bus", frame: "Ignored frame.", beats: ["Ignored beat.", PLAN.beats[1]] }];
    const goal = await plan(await plannedShort(brief));
    expect(requests).toHaveLength(1);
    expect(userText(requests[0]!)).toMatchObject({
      fixed: { "frame": "A cinematic bus shelter at dusk.", "beat 1": "He checks the road twice." },
      write: ["title", "beat 2"],
    });
    const saved = requireGoalShortContent(engine, goal).plan!;
    expect(saved.frame.prompt).toBe("A cinematic bus shelter at dusk.");
    expect(saved.segments.map((segment) => segment.prompt)).toEqual(["He checks the road twice.", PLAN.beats[1]]);
  });

  it("opens in review without a planner request when every part is authored", async () => {
    delete process.env.OPENAI_API_KEY;
    const goal = await plan(await plannedShort('he waits for a bus, 20 seconds. frame: "A bus shelter at dusk." beat 1: "He checks the road." beat 2: "He boards the bus."'));
    expect(requests).toEqual([]);
    expect(goal).toMatchObject({ status: "review", error: null });
    expect(requireGoalShortContent(engine, goal).plan).toMatchObject({
      title: "he waits for a bus, 20",
      frame: { prompt: "A bus shelter at dusk." },
      segments: [{ prompt: "He checks the road.", seconds: 10 }, { prompt: "He boards the bus.", seconds: 10 }],
    });
  });

  it("fails without OPENAI_API_KEY when parts are left to fill", async () => {
    delete process.env.OPENAI_API_KEY;
    const goal = await plan(await plannedShort('he waits for a bus. frame: "A bus shelter at dusk."'));
    expect(requests).toEqual([]);
    expect(goal).toMatchObject({ status: "failed", error: "Set OPENAI_API_KEY in Settings, or quote the frame and beat prompts." });
  });
});
