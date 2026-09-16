import type { Engine } from "videobook-engine";
import { z } from "zod";
import {
  chainStepSchema,
  type ChainPreflightContext,
} from "../chain-plan.js";
import {
  approveChainStep,
  cancelChainRun,
  getChainRun,
  preflightAndAccept,
  type ChainApprovalActor,
  type ChainRunRecord,
} from "../chain-executor.js";
import { AUTO_APPLY_TOOL_NAMES, effectForTool } from "../chat-router.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text", text }] };
}

function toolEffect(name: string): "read" | "mutation" | "generation" {
  return effectForTool(
    name,
    /^(?:generate|extend|upscale)_/u.test(name) ? "generation" : "action",
  );
}

async function preflightContext(
  engine: Engine,
  bookId: string,
  notebookId?: string,
): Promise<ChainPreflightContext> {
  const { getAllToolDefs } = await import("./index.js");
  const defs = getAllToolDefs(engine);
  return {
    engine,
    bookId,
    notebookId,
    toolSchemas: new Map(defs.map((definition) => [definition.name, definition.schema])),
    autoApplyTools: AUTO_APPLY_TOOL_NAMES,
    effectForTool: toolEffect,
  };
}

async function toolLookup(engine: Engine) {
  const { getAllToolDefs } = await import("./index.js");
  const defs = getAllToolDefs(engine);
  return (name: string) => defs.find((definition) => definition.name === name);
}

function publicRun(run: ChainRunRecord): Record<string, unknown> {
  return {
    kind: "chain-run",
    chain_id: run.chainId,
    request_id: run.requestId,
    status: run.status,
    error: run.error,
    awaiting_step_id: run.awaitingStepId,
    steps: run.steps.map((step) => ({
      id: step.id,
      tool: step.tool,
      status: step.status,
      outputs: step.outputs,
      error: step.error,
      child_job_ids: step.childJobIds,
      requires_approval: step.requiresApproval,
      approved_at: step.approval?.approvedAt ?? null,
      review: step.review,
    })),
  };
}

export function chainDef(engine: Engine): ToolDef {
  return {
    name: "chain",
    description:
      "Run a bounded ordered list of existing book actions, passing earlier step outputs through structured {$ref:{step_id,output}} references. A step that spends money stops first and waits for its own review. Use action=run to start, action=status or action=cancel with chain_id to inspect or stop a run, and action=approve with chain_id and step_id to let a waiting step spend and carry on. Cancelling drops every remaining step.",
    scope: "book",
    schema: {
      action: z.enum(["run", "status", "cancel", "approve"]).default("run"),
      version: z.literal(1).optional(),
      book_id: z.string().uuid().describe("Book UUID"),
      notebook_id: z.string().uuid().optional()
        .describe("Active notebook UUID for resolving @a1-@bl8 targets"),
      request_id: z.string().min(1).optional()
        .describe("Idempotency key for a run"),
      chain_id: z.string().uuid().optional()
        .describe("Existing chain id for status or cancel"),
      steps: z.array(chainStepSchema).optional()
        .describe("Ordered steps for action=run"),
      step_id: z.string().min(1).max(64).optional()
        .describe("Step waiting for approval, required for action=approve"),
      actor: z.enum(["chat", "voice", "api"]).optional()
        .describe("Which surface approved the step"),
    },
    handler: async (args) => {
      const action = (args.action as "run" | "status" | "cancel" | "approve" | undefined)
        ?? "run";
      const bookId = args.book_id as string;
      const notebookId = args.notebook_id as string | undefined;
      const lookup = await toolLookup(engine);
      if (action === "status") {
        const chainId = args.chain_id;
        if (typeof chainId !== "string") return error("chain_id is required");
        const run = getChainRun(engine, chainId);
        if (!run || run.bookId !== bookId) return error("Chain run not found");
        return json(publicRun(run));
      }
      if (action === "approve") {
        const chainId = args.chain_id;
        const stepId = args.step_id;
        if (typeof chainId !== "string") return error("chain_id is required");
        if (typeof stepId !== "string") return error("step_id is required");
        const existing = getChainRun(engine, chainId);
        if (!existing || existing.bookId !== bookId) return error("Chain run not found");
        try {
          const actor = (args.actor as ChainApprovalActor | undefined) ?? "api";
          const run = approveChainStep(engine, chainId, stepId, actor, lookup);
          return run ? json(publicRun(run)) : error("Chain run not found");
        } catch (cause) {
          return error(cause instanceof Error ? cause.message : String(cause));
        }
      }
      if (action === "cancel") {
        const chainId = args.chain_id;
        if (typeof chainId !== "string") return error("chain_id is required");
        const existing = getChainRun(engine, chainId);
        if (!existing || existing.bookId !== bookId) return error("Chain run not found");
        const run = cancelChainRun(engine, chainId);
        return run ? json(publicRun(run)) : error("Chain run not found");
      }
      try {
        const context = await preflightContext(engine, bookId, notebookId);
        const run = await preflightAndAccept({
          action: "run",
          version: args.version ?? 1,
          book_id: bookId,
          notebook_id: notebookId,
          request_id: args.request_id,
          steps: args.steps,
        }, context, lookup);
        return json(publicRun(run));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return error(message);
      }
    },
  };
}

