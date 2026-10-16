import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "videobook-engine";

import { getAllToolDefs } from "./index.js";

describe("Videobook MCP parity", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("registers unique canonical and notebook-native tools", async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-parity-"));
    const fs = createEngine({ durableWrites: false, rootDir: root, initialBookName: "parity" });
    const names = getAllToolDefs(fs).map((definition) => definition.name);
    fs.close();

    expect(names).toHaveLength(246);
    expect(new Set(names).size).toBe(246);
    expect(names).toEqual(
      expect.arrayContaining([
        "save_post_to_icloud",
        "icloud_status",
        "post_icloud_sync_status",
        "draft_post_copy",
        "prepare_cold_open",
        "edit_cold_open",
        "analyze_music",
        "alive_captions",
        "set_alive_captions",
        "get_music_analysis",
        "get_sequence_rhythm",
        "update_sequence_rhythm",
        "plan_music_video",
        "commit_music_video",
        "list_books",
        "list_workspace_actions",
        "forget_asset",
        "add_asset_tag",
        "remove_asset_tag",
        "restore_asset_tag",
        "suggest_asset_tags",
        "backfill_asset_tags",
        "retag_asset",
        "configure_asset_tagging",
        "create_book",
        "get_legacy_migration",
        "cancel_legacy_migration",
        "get_book",
        "get_book_usage",
        "list_notebooks",
        "create_notebook",
        "get_notebook",
        "create_notebook_cell",
        "update_notebook_cell",
        "relayout_notebook",
        "delete_notebook",
        "run_notebook",
        "list_jobs",
        "repair_library_search_indexes",
        "cancel_job",
        "retry_job",
        "list_cell_generations",
        "chain",
        "video_goal",
        "assemble_goal",
        "create_entity",
        "list_entities",
        "get_entity",
        "update_entity",
        "delete_entity",
        "storage_status",
        "storage_sync",
        "list_book_actions",
        "get_history_action",
        "get_image_subject_map",
        "analyze_image_subjects",
        "edit_image_subjects",
        "list_image_edit_models",
        "analyze_video",
        "export_transcript_srt",
        "generate_image",
        "generate_video",
        "generate_audio",
        "list_generation_models",
      ]),
    );
  });
});
