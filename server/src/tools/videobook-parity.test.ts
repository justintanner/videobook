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

    expect(names).toHaveLength(340);
    expect(new Set(names).size).toBe(340);
    expect(names).toEqual(
      expect.arrayContaining([
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
        "create_prompt_entity",
        "list_prompts",
        "get_prompt_entity",
        "create_scene_entity",
        "list_scenes",
        "get_scene_entity",
        "create_character_entity",
        "list_characters",
        "get_character_entity",
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
        "generate_kie_kling_3_0_omni_text_to_video",
        "generate_kie_kling_3_0_omni_image_to_video",
        "generate_kie_kling_3_0_omni_reference_to_video",
        "generate_kie_kling_3_0_omni_transformation",
        "generate_kie_kling_3_0_motion_control",
        "generate_kie_seedance_2_5_video",
        "generate_fal_wan_3_0_text_to_video",
        "generate_fal_wan_3_0_image_to_video",
        "generate_fal_wan_3_0_reference_to_video",
        "generate_fal_wan_3_0_prime_text_to_video",
        "generate_fal_wan_3_0_prime_image_to_video",
        "generate_fal_wan_3_0_prime_reference_to_video",
        "generate_kie_vidu_q4_image_to_video",
        "generate_kie_vidu_q4_reference_to_video",
        "generate_kie_wan_3_0_video",
        "generate_kie_wan_3_0_prime_video",
        "generate_kie_qwen_3_0_edit_image",
        "generate_fal_qwen_3_0_edit_image",
        "generate_kie_qwen_2_1_text_to_image",
        "generate_kie_qwen_2_1_edit_image",
      ]),
    );
  });
});
