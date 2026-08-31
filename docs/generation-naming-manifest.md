# Generation Naming Manifest

This is the authoritative registry-derived list of canonical generation and workflow action names. Historical names resolve persisted data to canonical names but are not exposed as MCP endpoints.

## Summary

- Total actions: 77
- Provider actions: 68
- Workflow and support actions: 9

## Naming grammar

Provider-backed actions use `<verb>_<provider>_<model>_<operation>`. Workflow actions use concise intent-based names.

| Canonical action | Provider | Apicity or internal identifier | Media | Operation | Picker visibility | Historical names (not exposed) |
| --- | --- | --- | --- | --- | --- | --- |
| `generate_kie_grok_imagine_image_to_video` | kie | `GrokImageToVideoRequestSchema` | video | image_to_video | visible | `generate_grok_imagine_video` |
| `generate_xai_grok_imagine_video` | xai | `XaiVideoGenerateRequestSchema` | video | generate_video | visible | `generate_grok_imagine_ref_video`, `generate_xai_grok_imagine_reference_to_video` |
| `generate_kie_grok_imagine_text_to_video` | kie | `GrokTextToVideoRequestSchema` | video | text_to_video | hidden_fal_variant | `generate_grok_imagine_t2v_video` |
| `extend_kie_grok_imagine_video` | kie | `GrokVideoExtendRequestSchema` | video | extend_video | hidden_fal_variant | `extend_grok_imagine_video` |
| `upscale_kie_grok_imagine_video` | kie | `GrokVideoUpscaleRequestSchema` | video | upscale_video | hidden_fal_variant | `upscale_grok_imagine_video` |
| `generate_kie_kling_3_0_omni_text_to_video` | kie | `KlingOmniTextToVideoRequestSchema` | video | text_to_video | visible |  |
| `generate_kie_kling_3_0_omni_image_to_video` | kie | `KlingOmniImageToVideoRequestSchema` | video | image_to_video | visible |  |
| `generate_kie_kling_3_0_omni_reference_to_video` | kie | `KlingOmniReferenceToVideoRequestSchema` | video | reference_to_video | visible |  |
| `generate_kie_kling_3_0_omni_transformation` | kie | `KlingOmniTransformationRequestSchema` | video | transformation | visible |  |
| `generate_kie_kling_3_0_motion_control` | kie | `KlingMotionControlRequestSchema` | video | motion_control | visible | `generate_kling30_motion_control_video` |
| `generate_kie_seedance_2_5_video` | kie | `Seedance25InputSchema` | video | image_to_video | visible | `generate_seedance25_video` |
| `generate_kie_gemini_omni_video` | kie | `GeminiOmniVideoRequestSchema` | video | image_to_video | visible | `generate_gemini_omni_video` |
| `generate_kie_wan_3_0_video` | kie | `Wan30VideoRequestSchema` | video | generate_video | visible |  |
| `generate_kie_wan_3_0_prime_video` | kie | `Wan30VideoPrimeRequestSchema` | video | generate_video | visible |  |
| `generate_kie_happyhorse_1_1_text_to_video` | kie | `HappyHorse11TextToVideoRequestSchema` | video | text_to_video | hidden_fal_variant | `generate_happyhorse_t2v_video` |
| `generate_kie_happyhorse_1_1_image_to_video` | kie | `HappyHorse11ImageToVideoRequestSchema` | video | image_to_video | visible | `generate_happyhorse_i2v_video` |
| `generate_kie_happyhorse_1_1_reference_to_video` | kie | `HappyHorse11ReferenceToVideoRequestSchema` | video | reference_to_video | hidden_fal_variant | `generate_happyhorse_ref_video` |
| `generate_kie_happyhorse_1_1_edit_video` | kie | `HappyHorseVideoEditRequestSchema` | video | edit_video | hidden_fal_variant | `generate_happyhorse_videoedit_video` |
| `generate_kie_minimax_h3_text_to_video` | kie | `MiniMaxH3TextToVideoRequestSchema` | video | text_to_video | visible |  |
| `generate_kie_minimax_h3_image_to_video` | kie | `MiniMaxH3ImageToVideoRequestSchema` | video | image_to_video | visible |  |
| `generate_kie_minimax_h3_reference_to_video` | kie | `MiniMaxH3ReferenceToVideoRequestSchema` | video | reference_to_video | visible |  |
| `generate_kie_volcengine_video_to_video_lip_sync` | kie | `VolcengineVideoToVideoLipSyncRequestSchema` | video | video_to_video_lip_sync | hidden_fal_variant | `generate_volcengine_lipsync_video` |
| `generate_kie_omnihuman_1_5_video` | kie | `Omnihuman15RequestSchema` | video | image_to_video | visible | `generate_omnihuman_video` |
| `generate_kie_veo_3_0_video` | kie | `VeoGenerateRequestSchema` | video | text_to_video | visible | `generate_veo3_video` |
| `generate_kie_veo_3_0_fast_video` | kie | `VeoGenerateRequestSchema` | video | text_to_video | visible | `generate_veo3_fast_video` |
| `generate_google_flow_veo_3_1_quality_video` | google_flow | `googleflow/video/veo-3.1-quality` | video | text_to_video | visible | `generate_veo31_video` |
| `generate_google_flow_veo_3_1_fast_video` | google_flow | `googleflow/video/veo-3.1-fast` | video | text_to_video | visible | `generate_veo31_fast_video` |
| `generate_google_flow_veo_3_1_lite_video` | google_flow | `googleflow/video/veo-3.1-lite` | video | text_to_video | visible | `generate_veo31_lite_video` |
| `generate_google_flow_veo_3_1_lite_low_priority_video` | google_flow | `googleflow/video/veo-3.1-lite-low-priority` | video | text_to_video | visible | `generate_veo31_lite_low_priority_video` |
| `generate_kie_grok_imagine_image_to_image` | kie | `GrokImageToImageRequestSchema` | image | image_to_image | visible | `generate_grok_imagine_image` |
| `generate_kie_grok_imagine_text_to_image` | kie | `GrokTextToImageRequestSchema` | image | text_to_image | hidden_fal_variant | `generate_grok_imagine_text_image` |
| `generate_kie_gpt_image_2_image_to_image` | kie | `GptImage2ImageToImageRequestSchema` | image | image_to_image | visible | `generate_gpt_image` |
| `generate_kie_gpt_image_2_text_to_image` | kie | `GptImage2TextToImageRequestSchema` | image | text_to_image | hidden_fal_variant | `generate_gpt_image_text` |
| `generate_kie_nano_banana_pro_text_to_image` | kie | `NanoBananaProRequestSchema` | image | text_to_image | visible | `generate_nano_banana_image` |
| `generate_kie_qwen_2_0_edit_image` | kie | `Qwen2ImageEditRequestSchema` | image | edit_image | visible | `generate_qwen2_image_edit` |
| `generate_kie_qwen_3_0_edit_image` | kie | `Qwen3ImageToImageRequestSchema` | image | edit_image | visible |  |
| `generate_kie_seedream_v5_lite_text_to_image` | kie | `SeedreamTextToImageRequestSchema` | image | text_to_image | hidden_fal_variant | `generate_seedream_text_image` |
| `generate_kie_seedream_v5_lite_image_to_image` | kie | `SeedreamImageToImageRequestSchema` | image | image_to_image | visible | `generate_seedream_image` |
| `generate_google_flow_omni_flash_video` | google_flow | `googleflow/video/omni-flash` | video | image_to_video | visible | `generate_google_omni_video` |
| `generate_google_flow_nano_banana_pro_image` | google_flow | `googleflow/image/nano-banana-pro` | image | text_to_image | visible | `generate_nano_banana_pro_google` |
| `generate_alibaba_qwen_2_0_text_to_image` | alibaba | `AlibabaQwenImageGenerationStableModelSchema` | image | text_to_image | visible | `generate_alibaba_qwen_image` |
| `generate_alibaba_qwen_2_0_edit_image` | alibaba | `AlibabaQwenImageEditStableModelSchema` | image | edit_image | visible | `generate_alibaba_qwen_image_edit` |
| `generate_fal_nano_banana_text_to_image` | fal | `fal-ai/nano-banana` | image | text_to_image | hidden_fal_variant | `generate_nano_banana_fal` |
| `generate_fal_nano_banana_edit_image` | fal | `fal-ai/nano-banana/edit` | image | edit_image | hidden_fal_variant | `generate_nano_banana_edit_fal` |
| `generate_fal_nano_banana_2_text_to_image` | fal | `fal-ai/nano-banana-2` | image | text_to_image | hidden_fal_variant | `generate_nano_banana_2_fal` |
| `generate_fal_nano_banana_2_edit_image` | fal | `fal-ai/nano-banana-2/edit` | image | edit_image | hidden_fal_variant | `generate_nano_banana_2_edit_fal` |
| `generate_fal_nano_banana_2_lite_text_to_image` | fal | `fal-ai/nano-banana-2-lite` | image | text_to_image | hidden_fal_variant | `generate_nano_banana_2_lite_fal` |
| `generate_fal_nano_banana_2_lite_edit_image` | fal | `fal-ai/nano-banana-2-lite/edit` | image | edit_image | hidden_fal_variant | `generate_nano_banana_2_lite_edit_fal` |
| `generate_fal_nano_banana_pro_text_to_image` | fal | `fal-ai/nano-banana-pro` | image | text_to_image | hidden_fal_variant | `generate_nano_banana_pro_fal` |
| `generate_fal_nano_banana_pro_edit_image` | fal | `fal-ai/nano-banana-pro/edit` | image | edit_image | hidden_fal_variant | `generate_nano_banana_pro_edit_fal` |
| `generate_fal_seedream_v5_lite_text_to_image` | fal | `fal-ai/seedream-v5-lite` | image | text_to_image | hidden_fal_variant | `generate_seedream_v5_lite_fal` |
| `generate_fal_seedream_v5_lite_edit_image` | fal | `fal-ai/seedream-v5-lite/edit` | image | edit_image | hidden_fal_variant | `generate_seedream_v5_lite_edit_fal` |
| `generate_fal_grok_imagine_text_to_image` | fal | `fal-ai/xai/grok-imagine/t2i` | image | text_to_image | hidden_fal_variant | `generate_grok_imagine_image_fal` |
| `generate_fal_grok_imagine_edit_image` | fal | `fal-ai/xai/grok-imagine/edit` | image | edit_image | hidden_fal_variant | `generate_grok_imagine_image_edit_fal` |
| `generate_fal_grok_imagine_video_image_to_video` | fal | `fal-ai/xai/grok-imagine-video/i2v` | video | image_to_video | hidden_fal_variant | `generate_grok_imagine_video_i2v_fal` |
| `generate_fal_grok_imagine_video_reference_to_video` | fal | `fal-ai/xai/grok-imagine-video/r2v` | video | reference_to_video | hidden_fal_variant | `generate_grok_imagine_video_r2v_fal`, `generate_grok_imagine_r2v_fal_video` |
| `extend_fal_grok_imagine_video` | fal | `fal-ai/xai/grok-imagine-video/extend` | video | extend_video | hidden_fal_variant | `generate_grok_imagine_video_extend_fal`, `generate_grok_imagine_extend_fal_video` |
| `generate_fal_grok_imagine_video_edit_video` | fal | `fal-ai/xai/grok-imagine-video/edit` | video | edit_video | hidden_fal_variant | `generate_grok_imagine_video_edit_fal` |
| `generate_fal_qwen_2_0_text_to_image` | fal | `fal-ai/qwen-image/t2i` | image | text_to_image | hidden_fal_variant | `generate_qwen_image_fal` |
| `generate_fal_qwen_2_0_edit_image` | fal | `fal-ai/qwen-image/edit` | image | edit_image | hidden_fal_variant | `generate_qwen_image_edit_fal` |
| `generate_fal_qwen_3_0_edit_image` | fal | `alibaba/qwen-image-3/edit` | image | edit_image | visible |  |
| `generate_fal_wan_3_0_text_to_video` | fal | `fal-ai/wan-3-0/t2v` | video | text_to_video | hidden_fal_variant |  |
| `generate_fal_wan_3_0_image_to_video` | fal | `fal-ai/wan-3-0/i2v` | video | image_to_video | hidden_fal_variant |  |
| `generate_fal_wan_3_0_reference_to_video` | fal | `fal-ai/wan-3-0/r2v` | video | reference_to_video | hidden_fal_variant |  |
| `generate_fal_wan_3_0_prime_text_to_video` | fal | `fal-ai/wan-3-0-prime/t2v` | video | text_to_video | hidden_fal_variant |  |
| `generate_fal_wan_3_0_prime_image_to_video` | fal | `fal-ai/wan-3-0-prime/i2v` | video | image_to_video | hidden_fal_variant |  |
| `generate_fal_wan_3_0_prime_reference_to_video` | fal | `fal-ai/wan-3-0-prime/r2v` | video | reference_to_video | hidden_fal_variant |  |
| `generate_elevenlabs_text_to_audio` | elevenlabs | `@apicity/elevenlabs` | audio | text_to_audio | workflow_tool | `generate_elevenlabs_t2a` |
| `extend_audio_asset` | workflow | `internal/audio/extend` | audio | extend_audio | workflow_tool | `extend_audio` |
| `generate_image_model_comparison` | workflow | `internal/gen-images-all` | image | model_comparison | workflow_tool | `gen_images_all_models` |
| `prepare_video_generation` | workflow | `internal/preview-video-gen` | workflow | prepare_generation | workflow_tool | `preview_video` |
| `prepare_image_generation` | workflow | `internal/preview-image-gen` | workflow | prepare_generation | workflow_tool | `preview_image` |
| `inspect_generation_request` | workflow | `internal/generation-payload` | workflow | inspect_request | workflow_tool | `generation_payload` |
| `build_generation_provider_payload` | workflow | `internal/translate-payload` | workflow | build_provider_payload | workflow_tool | `translate_payload` |
| `reconcile_project_work` | workflow | `internal/sync` | workflow | reconcile_work | workflow_tool | `sync` |
| `retry_generation` | workflow | `internal/retry-generation` | workflow | retry_generation | workflow_tool | `retry_generation` |
| `clean_failed_assets` | workflow | `internal/clear-failed-tasks` | workflow | clean_assets | workflow_tool | `clear_failed_tasks` |
