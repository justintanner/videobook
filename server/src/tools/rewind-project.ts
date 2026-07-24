import type { Engine } from "videobook-engine";
import { z } from "zod";
import { prepareProjectForRewind, resumeProjectAfterRewind } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

export function rewindProjectDef(fs: Engine): ToolDef {
  return {
    name: "rewind_project",
    description: "Restore a project revision and record the result as a new forward revision",
    schema: {
      commit_hash: z.string().min(7).describe("DoltLite revision hash or an unambiguous prefix"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { commit_hash, project_slug } = args as { commit_hash: string; project_slug: string };
      let prepared = false;
      let abortedJobs = 0;
      let failedPendingTasks = 0;
      try {
        const history = await fs.history.project(project_slug, 10_000);
        const matches = history.filter((commit) => commit.hash.startsWith(commit_hash));
        if (matches.length === 0) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Revision ${commit_hash} not found in project history. Use a hash from revision_history or the activity log.`,
            }],
          };
        }
        if (matches.length > 1) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Revision prefix ${commit_hash} is ambiguous (${matches.length} matches). Provide more characters.`,
            }],
          };
        }
        const resolvedHash = matches[0].hash;

        const queueResult = await prepareProjectForRewind(project_slug);
        prepared = true;
        abortedJobs = queueResult.abortedJobs;
        failedPendingTasks = queueResult.failedPendingTasks;

        const result = await fs.history.restoreProject(resolvedHash, project_slug);
        if (!result) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Failed to rewind project to ${resolvedHash}. The engine could not restore that commit.`,
            }],
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "rewound",
              project: project_slug,
              commit: resolvedHash,
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
