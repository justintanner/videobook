import { useCallback, useMemo, useState } from "react";
import { Loader2, RefreshCw, Shirt } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaItem } from "@/components/sidebar/types";
import type { CharacterProfile } from "@/hooks/useCharacterSlots";
import { useGenerateCharacter } from "@/hooks/useGenerateCharacter";
import type { UseMcpResult } from "use-mcp/react";

interface RerollSheetPanelProps {
  profile: CharacterProfile | null;
  projectSlug: string;
  sourceImage: MediaItem | null;
  wardrobe: MediaItem[];
  callTool: UseMcpResult["callTool"];
  callState: UseMcpResult["state"];
}

type Selection =
  | { kind: "neutral" }
  | { kind: "wardrobe"; assetId: string }
  | { kind: "text" };

export function RerollSheetPanel({
  profile,
  projectSlug,
  sourceImage,
  wardrobe,
  callTool,
  callState,
}: RerollSheetPanelProps) {
  const { generate, submitting } = useGenerateCharacter(callTool);
  const [selection, setSelection] = useState<Selection>({ kind: "neutral" });
  const [outfitText, setOutfitText] = useState("");

  const sourceAssetId = profile?.source_image_asset_id ?? null;

  const canSubmit = useMemo(() => {
    if (!profile || !sourceAssetId || callState !== "ready" || submitting) return false;
    if (selection.kind === "text" && !outfitText.trim()) return false;
    return true;
  }, [profile, sourceAssetId, callState, submitting, selection, outfitText]);

  const handleReroll = useCallback(async () => {
    if (!profile || !sourceAssetId) return;
    await generate({
      projectSlug,
      sourceImageSlug: sourceAssetId,
      profile,
      models: ["nano_banana_pro"],
      provider: "kie",
      outfitText: selection.kind === "text" ? outfitText.trim() : undefined,
      outfitImageSlug: selection.kind === "wardrobe" ? selection.assetId : undefined,
    });
  }, [profile, sourceAssetId, projectSlug, generate, selection, outfitText]);

  if (!profile) return null;

  return (
    <div className="w-80 shrink-0 border-l border-violet-500/20 overflow-y-auto bg-black/40 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <RefreshCw className="w-3 h-3 text-violet-300" />
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-violet-200">
          Re-render sheet
        </span>
      </div>
      <div className="text-[10px] font-mono text-violet-300/60 leading-tight">
        Generates a new char-* sheet using the same identity but a different outfit for the body shots.
      </div>

      {sourceImage && (
        <div>
          <div className="text-[9px] font-mono uppercase tracking-wider text-violet-300/70 mb-1">
            Identity source
          </div>
          <div className="flex items-center gap-2">
            <div className="w-12 h-12 rounded border border-violet-500/30 overflow-hidden bg-black shrink-0">
              {sourceImage.thumbnailSrc || sourceImage.filePath ? (
                <img
                  src={sourceImage.thumbnailSrc ?? sourceImage.filePath}
                  alt={sourceImage.slug}
                  className="w-full h-full object-cover"
                />
              ) : null}
            </div>
            <span className="text-[10px] font-mono text-violet-300/80 truncate" title={sourceImage.slug}>
              {sourceImage.slug}
            </span>
          </div>
        </div>
      )}

      <div>
        <div className="text-[9px] font-mono uppercase tracking-wider text-violet-300/70 mb-1.5">
          Outfit for body shots
        </div>
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setSelection({ kind: "neutral" })}
            className={cn(
              "w-full flex items-center gap-2 px-2 py-2 rounded border text-left transition-colors",
              selection.kind === "neutral"
                ? "border-violet-300 bg-violet-500/15"
                : "border-violet-500/20 hover:border-violet-400/50",
            )}
          >
            <Shirt className="w-3.5 h-3.5 text-violet-300" />
            <div className="min-w-0">
              <div className="text-[10px] font-mono uppercase tracking-wider text-violet-200">Neutral default</div>
              <div className="text-[9px] font-mono text-violet-300/60 truncate">
                form-fitting top + dark trousers
              </div>
            </div>
          </button>

          {wardrobe.length > 0 && (
            <div className="grid grid-cols-4 gap-1">
              {wardrobe.map((g) => {
                const active = selection.kind === "wardrobe" && selection.assetId === g.id;
                const thumb = g.thumbnailSrc || g.filePath;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setSelection({ kind: "wardrobe", assetId: g.id })}
                    title={g.slug}
                    className={cn(
                      "aspect-square rounded border overflow-hidden bg-black transition-colors",
                      active ? "border-violet-300" : "border-violet-500/20 hover:border-violet-400/60",
                    )}
                  >
                    {thumb ? (
                      <img src={thumb} alt={g.slug} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[8px] font-mono text-violet-400/60 px-1 text-center">
                        {g.slug}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <div>
            <button
              type="button"
              onClick={() => setSelection({ kind: "text" })}
              className={cn(
                "w-full text-left px-2 py-1.5 rounded border text-[10px] font-mono uppercase tracking-wider transition-colors",
                selection.kind === "text"
                  ? "border-violet-300 bg-violet-500/15 text-violet-100"
                  : "border-violet-500/20 text-violet-300/60 hover:border-violet-400/50",
              )}
            >
              Custom description
            </button>
            {selection.kind === "text" && (
              <textarea
                value={outfitText}
                placeholder="e.g. plain white t-shirt and dark jeans"
                onChange={(e) => setOutfitText(e.target.value)}
                rows={2}
                className={cn(
                  "mt-1 w-full bg-black/40 border border-violet-500/20 rounded px-2 py-1.5 text-[11px] font-mono text-violet-100 resize-y",
                  "focus:border-violet-400/60 focus:outline-none focus:ring-1 focus:ring-violet-400/40",
                )}
              />
            )}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={handleReroll}
        disabled={!canSubmit}
        className={cn(
          "w-full flex items-center justify-center gap-2 px-3 py-2 rounded text-[11px] font-mono uppercase tracking-wider transition-colors",
          canSubmit
            ? "bg-violet-500/20 border border-violet-300 text-violet-100 hover:bg-violet-500/30"
            : "bg-zinc-800 border border-zinc-700 text-zinc-500 cursor-not-allowed",
        )}
      >
        {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        {submitting ? "Enqueuing…" : "Re-render"}
      </button>
    </div>
  );
}
