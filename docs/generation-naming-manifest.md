# Apicity 0.8 Generation Naming Manifest

This document records the authoritative mapping of existing MCP generation and support action names to canonical names aligned with installed **Apicity 0.8.0** package surfaces (@apicity/kie, fal, xai, googleflow, alibaba, cost, elevenlabs).

## Summary
- Total Actions Audited: 92
- Primary Provider Actions: 83
- Workflow / Support Actions: 9

## Naming Grammar
Canonical Action Name Syntax: `<verb>_<provider>_<model>_<operation>`
- **Providers:** `kie`, `fal`, `xai`, `google_flow`, `alibaba`, `elevenlabs`
- **Operations:** `text_to_image`, `image_to_image`, `edit_image`, `text_to_video`, `image_to_video`, `reference_to_video`, `edit_video`, `extend_video`, `upscale_video`, `motion_control`, `video_to_video_lip_sync`, `text_to_audio`
- **No abbreviations:** `t2i`, `i2v`, `r2v`, `ref`, and `videoedit` are eliminated. Provider suffixes (`_fal`, `_google`) are replaced by provider-first prefixes (`generate_fal_`, `generate_google_flow_`).

## Authoritative Action Manifest

| Old MCP Action Name | Canonical Action Name | Provider | Exact Apicity 0.8 Identifier | Media | Operation | Picker Visibility | Aliases |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `generate_grok_imagine_video` | `generate_kie_grok_imagine_image_to_video` | kie | `GrokImageToVideoRequestSchema` | video | image_to_video | visible | `generate_grok_imagine_video` |
| `generate_grok_imagine_ref_video` | `generate_xai_grok_imagine_reference_to_video` | xai | `XaiVideoGenerateRequestSchema` | video | reference_to_video | visible | `generate_grok_imagine_ref_video` |
| `generate_grok_imagine_t2v_video` | `generate_kie_grok_imagine_text_to_video` | kie | `GrokTextToVideoRequestSchema` | video | text_to_video | hidden_fal_variant | `generate_grok_imagine_t2v_video` |
| `extend_grok_imagine_video` | `extend_kie_grok_imagine_video` | kie | `GrokVideoExtendRequestSchema` | video | extend_video | hidden_fal_variant | `extend_grok_imagine_video` |
| `upscale_grok_imagine_video` | `upscale_kie_grok_imagine_video` | kie | `GrokVideoUpscaleRequestSchema` | video | upscale_video | hidden_fal_variant | `upscale_grok_imagine_video` |
| `generate_kling30_video` | `generate_kie_kling_3_0_video` | kie | `KlingVideoRequestSchema` | video | image_to_video | visible | `generate_kling30_video` |
| `generate_kling30_motion_control_video` | `generate_kie_kling_3_0_motion_control` | kie | `KlingMotionControlRequestSchema` | video | motion_control | hidden_fal_variant | `generate_kling30_motion_control_video` |
| `generate_kling30_turbo_video` | `generate_kie_kling_3_0_turbo_video` | kie | `KlingV3TurboImageToVideoRequestSchema` | video | image_to_video | visible | `generate_kling30_turbo_video` |
| `generate_seedance2_video` | `generate_kie_seedance_2_0_video` | kie | `Seedance2InputSchema` | video | image_to_video | visible | `generate_seedance2_video` |
| `generate_seedance2_fast_video` | `generate_kie_seedance_2_0_fast_video` | kie | `Seedance2FastInputSchema` | video | image_to_video | visible | `generate_seedance2_fast_video` |
| `generate_seedance2_mini_video` | `generate_kie_seedance_2_0_mini_video` | kie | `Seedance2MiniInputSchema` | video | image_to_video | visible | `generate_seedance2_mini_video` |
| `generate_gemini_omni_video` | `generate_kie_gemini_omni_video` | kie | `GeminiOmniVideoRequestSchema` | video | image_to_video | visible | `generate_gemini_omni_video` |
| `generate_wan27_t2v_video` | `generate_kie_wan_2_7_text_to_video` | kie | `Wan27TextToVideoRequestSchema` | video | text_to_video | hidden_fal_variant | `generate_wan27_t2v_video` |
| `generate_wan27_i2v_video` | `generate_kie_wan_2_7_image_to_video` | kie | `Wan27ImageToVideoRequestSchema` | video | image_to_video | visible | `generate_wan27_i2v_video` |
| `generate_wan27_videoedit_video` | `generate_kie_wan_2_7_edit_video` | kie | `Wan27VideoEditRequestSchema` | video | edit_video | hidden_fal_variant | `generate_wan27_videoedit_video` |
| `generate_wan27_r2v_video` | `generate_kie_wan_2_7_reference_to_video` | kie | `Wan27RefToVideoRequestSchema` | video | reference_to_video | hidden_fal_variant | `generate_wan27_r2v_video` |
| `extend_wan27_video` | `extend_kie_wan_2_7_video` | kie | `Wan27VideoExtendRequestSchema` | video | extend_video | hidden_fal_variant | `extend_wan27_video` |
| `generate_happyhorse_t2v_video` | `generate_kie_happyhorse_1_1_text_to_video` | kie | `HappyHorse11TextToVideoRequestSchema` | video | text_to_video | hidden_fal_variant | `generate_happyhorse_t2v_video` |
| `generate_happyhorse_i2v_video` | `generate_kie_happyhorse_1_1_image_to_video` | kie | `HappyHorse11ImageToVideoRequestSchema` | video | image_to_video | visible | `generate_happyhorse_i2v_video` |
| `generate_happyhorse_ref_video` | `generate_kie_happyhorse_1_1_reference_to_video` | kie | `HappyHorse11ReferenceToVideoRequestSchema` | video | reference_to_video | hidden_fal_variant | `generate_happyhorse_ref_video` |
| `generate_happyhorse_videoedit_video` | `generate_kie_happyhorse_1_1_edit_video` | kie | `HappyHorseVideoEditRequestSchema` | video | edit_video | hidden_fal_variant | `generate_happyhorse_videoedit_video` |
| `generate_volcengine_lipsync_video` | `generate_kie_volcengine_video_to_video_lip_sync` | kie | `VolcengineVideoToVideoLipSyncRequestSchema` | video | video_to_video_lip_sync | hidden_fal_variant | `generate_volcengine_lipsync_video` |
| `generate_omnihuman_video` | `generate_kie_omnihuman_1_5_video` | kie | `Omnihuman15RequestSchema` | video | image_to_video | visible | `generate_omnihuman_video` |
| `generate_veo3_video` | `generate_kie_veo_3_0_video` | kie | `VeoGenerateRequestSchema` | video | text_to_video | visible | `generate_veo3_video` |
| `generate_veo3_fast_video` | `generate_kie_veo_3_0_fast_video` | kie | `VeoGenerateRequestSchema` | video | text_to_video | visible | `generate_veo3_fast_video` |
| `generate_veo31_video` | `generate_google_flow_veo_3_1_quality_video` | google_flow | `googleflow/video/veo-3.1-quality` | video | text_to_video | visible | `generate_veo31_video` |
| `generate_veo31_fast_video` | `generate_google_flow_veo_3_1_fast_video` | google_flow | `googleflow/video/veo-3.1-fast` | video | text_to_video | visible | `generate_veo31_fast_video` |
| `generate_veo31_lite_video` | `generate_google_flow_veo_3_1_lite_video` | google_flow | `googleflow/video/veo-3.1-lite` | video | text_to_video | visible | `generate_veo31_lite_video` |
| `generate_veo31_lite_low_priority_video` | `generate_google_flow_veo_3_1_lite_low_priority_video` | google_flow | `googleflow/video/veo-3.1-lite-low-priority` | video | text_to_video | visible | `generate_veo31_lite_low_priority_video` |
| `generate_grok_imagine_image` | `generate_kie_grok_imagine_image_to_image` | kie | `GrokImageToImageRequestSchema` | image | image_to_image | visible | `generate_grok_imagine_image` |
| `generate_grok_imagine_text_image` | `generate_kie_grok_imagine_text_to_image` | kie | `GrokTextToImageRequestSchema` | image | text_to_image | hidden_fal_variant | `generate_grok_imagine_text_image` |
| `generate_gpt_image` | `generate_kie_gpt_image_2_image_to_image` | kie | `GptImage2ImageToImageRequestSchema` | image | image_to_image | visible | `generate_gpt_image` |
| `generate_gpt_image_text` | `generate_kie_gpt_image_2_text_to_image` | kie | `GptImage2TextToImageRequestSchema` | image | text_to_image | hidden_fal_variant | `generate_gpt_image_text` |
| `generate_wan27_image` | `generate_kie_wan_2_7_text_to_image` | kie | `Wan27ImageRequestSchema` | image | text_to_image | visible | `generate_wan27_image` |
| `generate_wan27_image_pro` | `generate_kie_wan_2_7_pro_text_to_image` | kie | `Wan27ImageProRequestSchema` | image | text_to_image | visible | `generate_wan27_image_pro` |
| `generate_nano_banana_image` | `generate_kie_nano_banana_pro_text_to_image` | kie | `NanoBananaProRequestSchema` | image | text_to_image | visible | `generate_nano_banana_image` |
| `generate_qwen2_image_edit` | `generate_kie_qwen_2_0_edit_image` | kie | `Qwen2ImageEditRequestSchema` | image | edit_image | visible | `generate_qwen2_image_edit` |
| `generate_seedream_text_image` | `generate_kie_seedream_v5_lite_text_to_image` | kie | `SeedreamTextToImageRequestSchema` | image | text_to_image | hidden_fal_variant | `generate_seedream_text_image` |
| `generate_seedream_image` | `generate_kie_seedream_v5_lite_image_to_image` | kie | `SeedreamImageToImageRequestSchema` | image | image_to_image | visible | `generate_seedream_image` |
| `generate_google_omni_video` | `generate_google_flow_omni_flash_video` | google_flow | `googleflow/video/omni-flash` | video | image_to_video | visible | `generate_google_omni_video` |
| `generate_nano_banana_pro_google` | `generate_google_flow_nano_banana_pro_image` | google_flow | `googleflow/image/nano-banana-pro` | image | text_to_image | visible | `generate_nano_banana_pro_google` |
| `generate_alibaba_image` | `generate_alibaba_wan_2_1_text_to_image` | alibaba | `AlibabaImageGenerationParametersSchema` | image | text_to_image | visible | `generate_alibaba_image` |
| `generate_alibaba_image_pro` | `generate_alibaba_wan_2_1_pro_text_to_image` | alibaba | `AlibabaImageGenerationParametersSchema` | image | text_to_image | visible | `generate_alibaba_image_pro` |
| `generate_alibaba_qwen_image` | `generate_alibaba_qwen_2_0_text_to_image` | alibaba | `AlibabaQwenImageGenerationStableModelSchema` | image | text_to_image | visible | `generate_alibaba_qwen_image` |
| `generate_alibaba_qwen_image_edit` | `generate_alibaba_qwen_2_0_edit_image` | alibaba | `AlibabaQwenImageEditStableModelSchema` | image | edit_image | visible | `generate_alibaba_qwen_image_edit` |
| `generate_alibaba_video` | `generate_alibaba_wan_2_1_text_to_video` | alibaba | `AlibabaVideoSynthesisInputSchema` | video | text_to_video | visible | `generate_alibaba_video` |
| `generate_seedance2_i2v_fal` | `generate_fal_seedance_2_0_image_to_video` | fal | `fal-ai/bytedance/seedance/v2/i2v` | video | image_to_video | hidden_fal_variant | `generate_seedance2_i2v_fal` |
| `generate_seedance2_t2v_fal` | `generate_fal_seedance_2_0_text_to_video` | fal | `fal-ai/bytedance/seedance/v2/t2v` | video | text_to_video | hidden_fal_variant | `generate_seedance2_t2v_fal` |
| `generate_seedance2_r2v_fal` | `generate_fal_seedance_2_0_reference_to_video` | fal | `fal-ai/bytedance/seedance/v2/r2v` | video | reference_to_video | hidden_fal_variant | `generate_seedance2_r2v_fal` |
| `generate_seedance2_fast_t2v_fal` | `generate_fal_seedance_2_0_fast_text_to_video` | fal | `fal-ai/bytedance/seedance/v2/fast/t2v` | video | text_to_video | hidden_fal_variant | `generate_seedance2_fast_t2v_fal` |
| `generate_seedance2_fast_i2v_fal` | `generate_fal_seedance_2_0_fast_image_to_video` | fal | `fal-ai/bytedance/seedance/v2/fast/i2v` | video | image_to_video | hidden_fal_variant | `generate_seedance2_fast_i2v_fal` |
| `generate_seedance2_fast_r2v_fal` | `generate_fal_seedance_2_0_fast_reference_to_video` | fal | `fal-ai/bytedance/seedance/v2/fast/r2v` | video | reference_to_video | hidden_fal_variant | `generate_seedance2_fast_r2v_fal` |
| `generate_nano_banana_fal` | `generate_fal_nano_banana_text_to_image` | fal | `fal-ai/nano-banana` | image | text_to_image | hidden_fal_variant | `generate_nano_banana_fal` |
| `generate_nano_banana_edit_fal` | `generate_fal_nano_banana_edit_image` | fal | `fal-ai/nano-banana/edit` | image | edit_image | hidden_fal_variant | `generate_nano_banana_edit_fal` |
| `generate_nano_banana_2_fal` | `generate_fal_nano_banana_2_text_to_image` | fal | `fal-ai/nano-banana-2` | image | text_to_image | hidden_fal_variant | `generate_nano_banana_2_fal` |
| `generate_nano_banana_2_edit_fal` | `generate_fal_nano_banana_2_edit_image` | fal | `fal-ai/nano-banana-2/edit` | image | edit_image | hidden_fal_variant | `generate_nano_banana_2_edit_fal` |
| `generate_nano_banana_2_lite_fal` | `generate_fal_nano_banana_2_lite_text_to_image` | fal | `fal-ai/nano-banana-2-lite` | image | text_to_image | hidden_fal_variant | `generate_nano_banana_2_lite_fal` |
| `generate_nano_banana_2_lite_edit_fal` | `generate_fal_nano_banana_2_lite_edit_image` | fal | `fal-ai/nano-banana-2-lite/edit` | image | edit_image | hidden_fal_variant | `generate_nano_banana_2_lite_edit_fal` |
| `generate_nano_banana_pro_fal` | `generate_fal_nano_banana_pro_text_to_image` | fal | `fal-ai/nano-banana-pro` | image | text_to_image | hidden_fal_variant | `generate_nano_banana_pro_fal` |
| `generate_nano_banana_pro_edit_fal` | `generate_fal_nano_banana_pro_edit_image` | fal | `fal-ai/nano-banana-pro/edit` | image | edit_image | hidden_fal_variant | `generate_nano_banana_pro_edit_fal` |
| `generate_seedream_v5_lite_fal` | `generate_fal_seedream_v5_lite_text_to_image` | fal | `fal-ai/seedream-v5-lite` | image | text_to_image | hidden_fal_variant | `generate_seedream_v5_lite_fal` |
| `generate_seedream_v5_lite_edit_fal` | `generate_fal_seedream_v5_lite_edit_image` | fal | `fal-ai/seedream-v5-lite/edit` | image | edit_image | hidden_fal_variant | `generate_seedream_v5_lite_edit_fal` |
| `generate_wan27_fal` | `generate_fal_wan_2_7_text_to_image` | fal | `fal-ai/wan-v2-7/t2i` | image | text_to_image | hidden_fal_variant | `generate_wan27_fal` |
| `generate_wan27_edit_fal` | `generate_fal_wan_2_7_edit_image` | fal | `fal-ai/wan-v2-7/edit` | image | edit_image | hidden_fal_variant | `generate_wan27_edit_fal` |
| `generate_wan27_pro_fal` | `generate_fal_wan_2_7_pro_text_to_image` | fal | `fal-ai/wan-v2-7-pro/t2i` | image | text_to_image | hidden_fal_variant | `generate_wan27_pro_fal` |
| `generate_wan27_pro_edit_fal` | `generate_fal_wan_2_7_pro_edit_image` | fal | `fal-ai/wan-v2-7-pro/edit` | image | edit_image | hidden_fal_variant | `generate_wan27_pro_edit_fal` |
| `generate_wan27_t2v_fal` | `generate_fal_wan_2_7_text_to_video` | fal | `fal-ai/wan-v2-7/t2v` | video | text_to_video | hidden_fal_variant | `generate_wan27_t2v_fal` |
| `generate_wan27_i2v_fal` | `generate_fal_wan_2_7_image_to_video` | fal | `fal-ai/wan-v2-7/i2v` | video | image_to_video | hidden_fal_variant | `generate_wan27_i2v_fal` |
| `generate_wan27_r2v_fal` | `generate_fal_wan_2_7_reference_to_video` | fal | `fal-ai/wan-v2-7/r2v` | video | reference_to_video | hidden_fal_variant | `generate_wan27_r2v_fal` |
| `generate_wan27_videoedit_fal` | `generate_fal_wan_2_7_edit_video` | fal | `fal-ai/wan-v2-7/videoedit` | video | edit_video | hidden_fal_variant | `generate_wan27_videoedit_fal` |
| `generate_grok_imagine_image_fal` | `generate_fal_grok_imagine_text_to_image` | fal | `fal-ai/xai/grok-imagine/t2i` | image | text_to_image | hidden_fal_variant | `generate_grok_imagine_image_fal` |
| `generate_grok_imagine_image_edit_fal` | `generate_fal_grok_imagine_edit_image` | fal | `fal-ai/xai/grok-imagine/edit` | image | edit_image | hidden_fal_variant | `generate_grok_imagine_image_edit_fal` |
| `generate_grok_imagine_video_i2v_fal` | `generate_fal_grok_imagine_video_image_to_video` | fal | `fal-ai/xai/grok-imagine-video/i2v` | video | image_to_video | hidden_fal_variant | `generate_grok_imagine_video_i2v_fal` |
| `generate_grok_imagine_video_r2v_fal` | `generate_fal_grok_imagine_video_reference_to_video` | fal | `fal-ai/xai/grok-imagine-video/r2v` | video | reference_to_video | hidden_fal_variant | `generate_grok_imagine_video_r2v_fal` |
| `generate_grok_imagine_video_extend_fal` | `extend_fal_grok_imagine_video` | fal | `fal-ai/xai/grok-imagine-video/extend` | video | extend_video | hidden_fal_variant | `generate_grok_imagine_video_extend_fal` |
| `generate_grok_imagine_video_edit_fal` | `generate_fal_grok_imagine_video_edit_video` | fal | `fal-ai/xai/grok-imagine-video/edit` | video | edit_video | hidden_fal_variant | `generate_grok_imagine_video_edit_fal` |
| `generate_kling_v3_pro_t2v_fal` | `generate_fal_kling_video_v3_pro_text_to_video` | fal | `fal-ai/kling-video/v3/pro/t2v` | video | text_to_video | hidden_fal_variant | `generate_kling_v3_pro_t2v_fal` |
| `generate_kling_v3_pro_i2v_fal` | `generate_fal_kling_video_v3_pro_image_to_video` | fal | `fal-ai/kling-video/v3/pro/i2v` | video | image_to_video | hidden_fal_variant | `generate_kling_v3_pro_i2v_fal` |
| `generate_kling_v3_standard_t2v_fal` | `generate_fal_kling_video_v3_standard_text_to_video` | fal | `fal-ai/kling-video/v3/standard/t2v` | video | text_to_video | hidden_fal_variant | `generate_kling_v3_standard_t2v_fal` |
| `generate_kling_v3_standard_i2v_fal` | `generate_fal_kling_video_v3_standard_image_to_video` | fal | `fal-ai/kling-video/v3/standard/i2v` | video | image_to_video | hidden_fal_variant | `generate_kling_v3_standard_i2v_fal` |
| `generate_qwen_image_fal` | `generate_fal_qwen_2_0_text_to_image` | fal | `fal-ai/qwen-image/t2i` | image | text_to_image | hidden_fal_variant | `generate_qwen_image_fal` |
| `generate_qwen_image_edit_fal` | `generate_fal_qwen_2_0_edit_image` | fal | `fal-ai/qwen-image/edit` | image | edit_image | hidden_fal_variant | `generate_qwen_image_edit_fal` |
| `generate_elevenlabs_t2a` | `generate_elevenlabs_text_to_audio` | elevenlabs | `@apicity/elevenlabs` | audio | text_to_audio | workflow_tool | `generate_elevenlabs_t2a` |
| `extend_audio` | `extend_audio_asset` | workflow | `internal/audio/extend` | audio | extend_video | workflow_tool | `extend_audio` |
| `gen_images_all_models` | `generate_image_model_comparison` | workflow | `internal/gen-images-all` | image | model_comparison | workflow_tool | `gen_images_all_models` |
| `preview_video` | `prepare_video_generation` | workflow | `internal/preview-video-gen` | workflow | prepare_generation | workflow_tool | `preview_video` |
| `preview_image` | `prepare_image_generation` | workflow | `internal/preview-image-gen` | workflow | prepare_generation | workflow_tool | `preview_image` |
| `generation_payload` | `inspect_generation_request` | workflow | `internal/generation-payload` | workflow | inspect_request | workflow_tool | `generation_payload` |
| `translate_payload` | `build_generation_provider_payload` | workflow | `internal/translate-payload` | workflow | build_provider_payload | workflow_tool | `translate_payload` |
| `sync` | `reconcile_project_work` | workflow | `internal/sync` | workflow | reconcile_work | workflow_tool | `sync` |
| `retry_generation` | `retry_generation` | workflow | `internal/retry-generation` | workflow | retry_generation | workflow_tool | `retry_generation` |
| `clear_failed_tasks` | `clean_failed_assets` | workflow | `internal/clear-failed-tasks` | workflow | clean_assets | workflow_tool | `clear_failed_tasks` |

## Special Case Decisions
- **`generate_grok_imagine_video` -> `generate_kie_grok_imagine_image_to_video`**: Kie image-to-video action. The distinct xAI reference endpoint uses generate_xai_grok_imagine_reference_to_video.
- **`generate_grok_imagine_ref_video` -> `generate_xai_grok_imagine_reference_to_video`**: xAI reference-to-video action. Legacy abbreviation 'ref' replaced with 'reference_to_video'.
- **`generate_grok_imagine_t2v_video` -> `generate_kie_grok_imagine_text_to_video`**: Kie text-to-video action. Abbreviation 't2v' and suffix 'video' removed.
- **`extend_grok_imagine_video` -> `extend_kie_grok_imagine_video`**: Kie video extension action. Provider 'kie' made explicit.
- **`upscale_grok_imagine_video` -> `upscale_kie_grok_imagine_video`**: Kie video upscale action. Provider 'kie' made explicit.
- **`generate_kling30_video` -> `generate_kie_kling_3_0_video`**: Kie Kling 3.0 main action. Model version normalized to kling_3_0.
- **`generate_kling30_motion_control_video` -> `generate_kie_kling_3_0_motion_control`**: Kie Kling 3.0 motion control. Suffix 'video' trimmed.
- **`generate_kling30_turbo_video` -> `generate_kie_kling_3_0_turbo_video`**: Kie Kling 3.0 Turbo video action. Normalized model name kling_3_0_turbo.
- **`generate_seedance2_video` -> `generate_kie_seedance_2_0_video`**: Kie Seedance 2.0 main video action. Version seedance_2_0 normalized.
- **`generate_seedance2_fast_video` -> `generate_kie_seedance_2_0_fast_video`**: Kie Seedance 2.0 Fast video action.
- **`generate_seedance2_mini_video` -> `generate_kie_seedance_2_0_mini_video`**: Kie Seedance 2.0 Mini video action.
- **`generate_gemini_omni_video` -> `generate_kie_gemini_omni_video`**: Kie Gemini Omni video action. Distinguished from Google Flow Gemini Omni Flash.
- **`generate_wan27_t2v_video` -> `generate_kie_wan_2_7_text_to_video`**: Kie Wan 2.7 text-to-video action. 't2v' and trailing 'video' removed.
- **`generate_wan27_i2v_video` -> `generate_kie_wan_2_7_image_to_video`**: Kie Wan 2.7 image-to-video action.
- **`generate_wan27_videoedit_video` -> `generate_kie_wan_2_7_edit_video`**: Kie Wan 2.7 video edit action. 'videoedit_video' -> 'edit_video'.
- **`generate_wan27_r2v_video` -> `generate_kie_wan_2_7_reference_to_video`**: Kie Wan 2.7 reference-to-video action.
- **`extend_wan27_video` -> `extend_kie_wan_2_7_video`**: Kie Wan 2.7 video extension action.
- **`generate_happyhorse_t2v_video` -> `generate_kie_happyhorse_1_1_text_to_video`**: Kie Happy Horse 1.1 text-to-video action.
- **`generate_happyhorse_i2v_video` -> `generate_kie_happyhorse_1_1_image_to_video`**: Kie Happy Horse 1.1 image-to-video action.
- **`generate_happyhorse_ref_video` -> `generate_kie_happyhorse_1_1_reference_to_video`**: Kie Happy Horse 1.1 reference-to-video action.
- **`generate_happyhorse_videoedit_video` -> `generate_kie_happyhorse_1_1_edit_video`**: Kie Happy Horse 1.1 video edit action.
- **`generate_volcengine_lipsync_video` -> `generate_kie_volcengine_video_to_video_lip_sync`**: Kie Volcengine Lip Sync video action. Operation spelled in full.
- **`generate_omnihuman_video` -> `generate_kie_omnihuman_1_5_video`**: Kie Omnihuman 1.5 video generation action.
- **`generate_veo3_video` -> `generate_kie_veo_3_0_video`**: Kie Veo 3.0 video action.
- **`generate_veo3_fast_video` -> `generate_kie_veo_3_0_fast_video`**: Kie Veo 3.0 Fast video action.
- **`generate_veo31_video` -> `generate_google_flow_veo_3_1_quality_video`**: Google Flow Veo 3.1 Quality video action.
- **`generate_veo31_fast_video` -> `generate_google_flow_veo_3_1_fast_video`**: Google Flow Veo 3.1 Fast video action.
- **`generate_veo31_lite_video` -> `generate_google_flow_veo_3_1_lite_video`**: Google Flow Veo 3.1 Lite video action.
- **`generate_veo31_lite_low_priority_video` -> `generate_google_flow_veo_3_1_lite_low_priority_video`**: Google Flow Veo 3.1 Lite Low Priority video action.
- **`generate_grok_imagine_image` -> `generate_kie_grok_imagine_image_to_image`**: Kie Grok Imagine image-to-image. Default _provider='kie'.
- **`generate_grok_imagine_text_image` -> `generate_kie_grok_imagine_text_to_image`**: Kie Grok Imagine text-to-image.
- **`generate_gpt_image` -> `generate_kie_gpt_image_2_image_to_image`**: Kie GPT Image 2 image-to-image action.
- **`generate_gpt_image_text` -> `generate_kie_gpt_image_2_text_to_image`**: Kie GPT Image 2 text-to-image action.
- **`generate_wan27_image` -> `generate_kie_wan_2_7_text_to_image`**: Kie Wan 2.7 text-to-image action.
- **`generate_wan27_image_pro` -> `generate_kie_wan_2_7_pro_text_to_image`**: Kie Wan 2.7 Pro text-to-image action.
- **`generate_nano_banana_image` -> `generate_kie_nano_banana_pro_text_to_image`**: Kie Nano Banana Pro text-to-image action.
- **`generate_qwen2_image_edit` -> `generate_kie_qwen_2_0_edit_image`**: Kie Qwen 2.0 image edit action.
- **`generate_seedream_text_image` -> `generate_kie_seedream_v5_lite_text_to_image`**: Kie Seedream V5 Lite text-to-image action.
- **`generate_seedream_image` -> `generate_kie_seedream_v5_lite_image_to_image`**: Kie Seedream V5 Lite image-to-image action.
- **`generate_google_omni_video` -> `generate_google_flow_omni_flash_video`**: Google Flow Gemini Omni Flash video generation.
- **`generate_nano_banana_pro_google` -> `generate_google_flow_nano_banana_pro_image`**: Google Flow Nano Banana Pro image generation.
- **`generate_alibaba_image` -> `generate_alibaba_wan_2_1_text_to_image`**: Alibaba Wan 2.1 text-to-image action.
- **`generate_alibaba_image_pro` -> `generate_alibaba_wan_2_1_pro_text_to_image`**: Alibaba Wan 2.1 Pro text-to-image action.
- **`generate_alibaba_qwen_image` -> `generate_alibaba_qwen_2_0_text_to_image`**: Alibaba Qwen 2.0 text-to-image action.
- **`generate_alibaba_qwen_image_edit` -> `generate_alibaba_qwen_2_0_edit_image`**: Alibaba Qwen 2.0 image edit action.
- **`generate_alibaba_video` -> `generate_alibaba_wan_2_1_text_to_video`**: Alibaba Wan 2.1 text-to-video action.
- **`generate_seedance2_i2v_fal` -> `generate_fal_seedance_2_0_image_to_video`**: Fal Seedance 2.0 image-to-video endpoint.
- **`generate_seedance2_t2v_fal` -> `generate_fal_seedance_2_0_text_to_video`**: Fal Seedance 2.0 text-to-video endpoint.
- **`generate_seedance2_r2v_fal` -> `generate_fal_seedance_2_0_reference_to_video`**: Fal Seedance 2.0 reference-to-video endpoint.
- **`generate_seedance2_fast_t2v_fal` -> `generate_fal_seedance_2_0_fast_text_to_video`**: Fal Seedance 2.0 Fast text-to-video endpoint.
- **`generate_seedance2_fast_i2v_fal` -> `generate_fal_seedance_2_0_fast_image_to_video`**: Fal Seedance 2.0 Fast image-to-video endpoint.
- **`generate_seedance2_fast_r2v_fal` -> `generate_fal_seedance_2_0_fast_reference_to_video`**: Fal Seedance 2.0 Fast reference-to-video endpoint.
- **`generate_nano_banana_fal` -> `generate_fal_nano_banana_text_to_image`**: Fal Nano Banana text-to-image endpoint.
- **`generate_nano_banana_edit_fal` -> `generate_fal_nano_banana_edit_image`**: Fal Nano Banana edit-image endpoint.
- **`generate_nano_banana_2_fal` -> `generate_fal_nano_banana_2_text_to_image`**: Fal Nano Banana 2 text-to-image endpoint.
- **`generate_nano_banana_2_edit_fal` -> `generate_fal_nano_banana_2_edit_image`**: Fal Nano Banana 2 edit-image endpoint.
- **`generate_nano_banana_2_lite_fal` -> `generate_fal_nano_banana_2_lite_text_to_image`**: Fal Nano Banana 2 Lite text-to-image endpoint.
- **`generate_nano_banana_2_lite_edit_fal` -> `generate_fal_nano_banana_2_lite_edit_image`**: Fal Nano Banana 2 Lite edit-image endpoint.
- **`generate_nano_banana_pro_fal` -> `generate_fal_nano_banana_pro_text_to_image`**: Fal Nano Banana Pro text-to-image endpoint.
- **`generate_nano_banana_pro_edit_fal` -> `generate_fal_nano_banana_pro_edit_image`**: Fal Nano Banana Pro edit-image endpoint.
- **`generate_seedream_v5_lite_fal` -> `generate_fal_seedream_v5_lite_text_to_image`**: Fal Seedream V5 Lite text-to-image endpoint.
- **`generate_seedream_v5_lite_edit_fal` -> `generate_fal_seedream_v5_lite_edit_image`**: Fal Seedream V5 Lite edit-image endpoint.
- **`generate_wan27_fal` -> `generate_fal_wan_2_7_text_to_image`**: Fal Wan 2.7 text-to-image endpoint.
- **`generate_wan27_edit_fal` -> `generate_fal_wan_2_7_edit_image`**: Fal Wan 2.7 edit-image endpoint.
- **`generate_wan27_pro_fal` -> `generate_fal_wan_2_7_pro_text_to_image`**: Fal Wan 2.7 Pro text-to-image endpoint.
- **`generate_wan27_pro_edit_fal` -> `generate_fal_wan_2_7_pro_edit_image`**: Fal Wan 2.7 Pro edit-image endpoint.
- **`generate_wan27_t2v_fal` -> `generate_fal_wan_2_7_text_to_video`**: Fal Wan 2.7 text-to-video endpoint.
- **`generate_wan27_i2v_fal` -> `generate_fal_wan_2_7_image_to_video`**: Fal Wan 2.7 image-to-video endpoint.
- **`generate_wan27_r2v_fal` -> `generate_fal_wan_2_7_reference_to_video`**: Fal Wan 2.7 reference-to-video endpoint.
- **`generate_wan27_videoedit_fal` -> `generate_fal_wan_2_7_edit_video`**: Fal Wan 2.7 video edit endpoint.
- **`generate_grok_imagine_image_fal` -> `generate_fal_grok_imagine_text_to_image`**: Fal Grok Imagine text-to-image endpoint.
- **`generate_grok_imagine_image_edit_fal` -> `generate_fal_grok_imagine_edit_image`**: Fal Grok Imagine edit-image endpoint.
- **`generate_grok_imagine_video_i2v_fal` -> `generate_fal_grok_imagine_video_image_to_video`**: Fal Grok Imagine Video image-to-video endpoint.
- **`generate_grok_imagine_video_r2v_fal` -> `generate_fal_grok_imagine_video_reference_to_video`**: Fal Grok Imagine Video reference-to-video endpoint.
- **`generate_grok_imagine_video_extend_fal` -> `extend_fal_grok_imagine_video`**: Fal Grok Imagine Video extend endpoint.
- **`generate_grok_imagine_video_edit_fal` -> `generate_fal_grok_imagine_video_edit_video`**: Fal Grok Imagine Video edit endpoint.
- **`generate_kling_v3_pro_t2v_fal` -> `generate_fal_kling_video_v3_pro_text_to_video`**: Fal Kling V3 Pro text-to-video endpoint.
- **`generate_kling_v3_pro_i2v_fal` -> `generate_fal_kling_video_v3_pro_image_to_video`**: Fal Kling V3 Pro image-to-video endpoint.
- **`generate_kling_v3_standard_t2v_fal` -> `generate_fal_kling_video_v3_standard_text_to_video`**: Fal Kling V3 Standard text-to-video endpoint.
- **`generate_kling_v3_standard_i2v_fal` -> `generate_fal_kling_video_v3_standard_image_to_video`**: Fal Kling V3 Standard image-to-video endpoint.
- **`generate_qwen_image_fal` -> `generate_fal_qwen_2_0_text_to_image`**: Fal Qwen 2.0 text-to-image endpoint.
- **`generate_qwen_image_edit_fal` -> `generate_fal_qwen_2_0_edit_image`**: Fal Qwen 2.0 edit-image endpoint.
- **`generate_elevenlabs_t2a` -> `generate_elevenlabs_text_to_audio`**: ElevenLabs text-to-audio generation tool.
- **`extend_audio` -> `extend_audio_asset`**: Audio extend workflow action.
- **`gen_images_all_models` -> `generate_image_model_comparison`**: Multi-model image comparison tool.
- **`preview_video` -> `prepare_video_generation`**: Renamed preview_video -> prepare_video_generation to reflect parameter resolution intent without generation.
- **`preview_image` -> `prepare_image_generation`**: Renamed preview_image -> prepare_image_generation.
- **`generation_payload` -> `inspect_generation_request`**: Renamed generation_payload -> inspect_generation_request.
- **`translate_payload` -> `build_generation_provider_payload`**: Renamed translate_payload -> build_generation_provider_payload.
- **`sync` -> `reconcile_project_work`**: Renamed sync -> reconcile_project_work to reflect provider polling & project reconciliation.
- **`retry_generation` -> `retry_generation`**: Retained retry_generation as canonical (already clear).
- **`clear_failed_tasks` -> `clean_failed_assets`**: Renamed clear_failed_tasks -> clean_failed_assets.
