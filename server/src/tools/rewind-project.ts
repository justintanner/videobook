import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import { prepareProjectForRewind, resumeProjectAfterRewind } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

export function rewindProjectDef(fs: VideocityFs): ToolDef {
  return {
    name: "rewind_project",
    description: "Rewind a project to a previous git commit (creates detached HEAD)",
    schema: {
      commit_hash: z.string().describe("Git commit hash to rewind to"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { commit_hash, project_slug } = args as { commit_hash: string; project_slug: string };
      let prepared = false;
      let abortedJobs = 0;
      let failedPendingTasks = 0;
      try {
        const history = await fs.getHistory(project_slug, 10_000);
        if (!history.some((commit) => commit.hash === commit_hash)) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: "Failed to rewind project. Check commit hash.",
            }],
          };
        }

        const queueResult = await prepareProjectForRewind(project_slug);
        prepared = true;
        abortedJobs = queueResult.abortedJobs;
        failedPendingTasks = queueResult.failedPendingTasks;

        const result = await fs.rewindProject(commit_hash, project_slug);
        if (!result) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: "Failed to rewind project. Check commit hash.",
            }],
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "rewound",
              project: project_slug,
              commit: commit_hash,
              aborted_jobs: abortedJobs,
              failed_pending_tasks: failedPendingTasks,
            }),
          }],
        };
      } catch (error) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          }],
        };
      } finally {
        if (prepared) {
          await resumeProjectAfterRewind(project_slug).catch(() => {});
        }
      }
    },
  };
}

export function registerRewindProjectTool(server: McpServer, fs: VideocityFs): void {
  const def = rewindProjectDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
