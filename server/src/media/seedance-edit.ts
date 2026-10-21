export const SEEDANCE_EDIT_DESCRIPTION = "Edit video follows the source aspect ratio and duration. Connect one 4–30 second video plus optional image or audio references.";

export function isSeedanceEdit(model: string, mode: unknown): boolean {
  return model === "kie:bytedance/seedance-2-5" && mode === "v2v";
}

export function seedanceEditFailure(model: unknown, message: string): string {
  if (model !== "kie:bytedance/seedance-2-5" || !/video edit/i.test(message)) return message;
  return `${message} Select Edit video (mode v2v) with one 4–30 second source video; this sets aspect_ratio=adaptive and duration=-1. Review the preview before retrying.`;
}
