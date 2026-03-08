import type { ClipfirstFs } from "clipfirst-fs";

export type DialogQuality = {
  hasDialog: boolean;
  reason: "real_dialog" | "no_transcription" | "empty" | "too_short" | "noise_only" | "nonsensical";
  text: string;
  wordCount: number;
};

export function assessDialogQuality(data: { text?: string }): DialogQuality {
  const raw = data.text ?? "";
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { hasDialog: false, reason: "empty", text: trimmed, wordCount: 0 };
  }

  const stripped = trimmed.replace(/\[[^\]]*\]/g, "").trim();
  if (stripped.length === 0) {
    return { hasDialog: false, reason: "noise_only", text: trimmed, wordCount: 0 };
  }

  const words = stripped.split(/\s+/);
  const wordCount = words.length;

  if (wordCount < 3) {
    return { hasDialog: false, reason: "too_short", text: trimmed, wordCount };
  }

  const uniqueWords = new Set(words.map((w) => w.toLowerCase()));
  if (uniqueWords.size / wordCount < 0.3) {
    return { hasDialog: false, reason: "nonsensical", text: trimmed, wordCount };
  }

  return { hasDialog: true, reason: "real_dialog", text: trimmed, wordCount };
}

export async function readAndAssessDialog(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
): Promise<DialogQuality> {
  const result = await fs.readFile(assetId, ".analysis.gpt4otrans.json", projectSlug);
  if (!result.ok) {
    return { hasDialog: false, reason: "no_transcription", text: "", wordCount: 0 };
  }
  try {
    const data = JSON.parse(result.value.toString()) as { text?: string };
    return assessDialogQuality(data);
  } catch {
    return { hasDialog: false, reason: "no_transcription", text: "", wordCount: 0 };
  }
}
