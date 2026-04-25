import { useCallback, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";
import type { SlotKind } from "@/hooks/useCharacterSlots";
import { toast } from "@/hooks/useToast";

export interface UseCharacterPinResult {
  pin: (slot: SlotKind, assetId: string) => Promise<boolean>;
  unpin: (slot: SlotKind, assetId: string) => Promise<boolean>;
  submitting: boolean;
}

export function useCharacterPin(
  callTool: UseMcpResult["callTool"],
  projectSlug: string | undefined,
  charAssetId: string | null,
  onChange?: () => void,
): UseCharacterPinResult {
  const [submitting, setSubmitting] = useState(false);
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const run = useCallback(
    async (toolName: "pin_character_slot" | "unpin_character_slot", slot: SlotKind, assetId: string): Promise<boolean> => {
      if (!projectSlug || !charAssetId) return false;
      setSubmitting(true);
      try {
        const res = await callToolRef.current(toolName, {
          project_slug: projectSlug,
          char_asset_id: charAssetId,
          slot,
          asset_id: assetId,
        });
        if (res.isError) {
          const content = res.content as Array<{ type: string; text: string }> | undefined;
          const msg = content?.[0]?.text ?? `${toolName} failed`;
          toast({ title: toolName === "pin_character_slot" ? "Pin failed" : "Unpin failed", description: msg, duration: 4000 });
          return false;
        }
        onChangeRef.current?.();
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast({ title: toolName === "pin_character_slot" ? "Pin failed" : "Unpin failed", description: msg, duration: 4000 });
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [projectSlug, charAssetId],
  );

  const pin = useCallback((slot: SlotKind, assetId: string) => run("pin_character_slot", slot, assetId), [run]);
  const unpin = useCallback((slot: SlotKind, assetId: string) => run("unpin_character_slot", slot, assetId), [run]);

  return { pin, unpin, submitting };
}
