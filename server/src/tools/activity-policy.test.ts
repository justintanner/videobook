import { describe, expect, it } from "vitest";

import {
  actionNameForTool,
  isExcludedAction,
  isLoggedToolActivity,
} from "./activity-policy.js";

const success = { content: [{ type: "text" as const, text: "{}" }] };

describe("Videobook activity policy", () => {
  it.each([
    "get_character",
    "get_notebook",
    "get_prompt",
    "get_scene",
    "get_watermark_config",
    "list_characters",
    "list_jobs",
    "list_notebooks",
    "list_prompts",
    "list_scenes",
    "revision_history",
    "read_transcript",
    "search_archive",
    "storage_status",
  ])("does not log read-only tool %s", (toolName) => {
    expect(
      isLoggedToolActivity(toolName, { project_slug: "studio" }, success),
    ).toBe(false);
    expect(isExcludedAction(actionNameForTool(toolName))).toBe(true);
  });

  it.each([
    "create_prompt",
    "update_character",
    "delete_scene",
    "update_notebook",
    "run_notebook",
  ])("logs mutating tool %s", (toolName) => {
    expect(
      isLoggedToolActivity(toolName, { project_slug: "studio" }, success),
    ).toBe(true);
    expect(isExcludedAction(actionNameForTool(toolName))).toBe(false);
  });
});
