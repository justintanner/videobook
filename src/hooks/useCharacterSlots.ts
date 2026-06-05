import { useCallback, useEffect, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";

export type CharacterSubjectKind = "female" | "male" | "animal" | "other";

export interface CharacterProfile {
  name?: string;
  subject_kind: CharacterSubjectKind;
  // female / male only
  age?: string;
  ethnicity?: string;
  height?: string;
  build?: string;
  bust?: string;
  waist?: string;
  hips?: string;
  face?: string;
  hair?: string;
  eyes?: string;
  skin?: string;
  // animal / other only
  other?: string;
  source_image_asset_id: string;
  wardrobe?: string[];
  poses?: string[];
  backdrop?: string[];
  outfits?: string[];
}

const FREEFORM_SUBJECT_KINDS: ReadonlySet<CharacterSubjectKind> = new Set(["animal", "other"]);

export function isFreeformSubject(kind: CharacterSubjectKind): boolean {
  return FREEFORM_SUBJECT_KINDS.has(kind);
}

function normalizeCharacterProfile(raw: unknown): CharacterProfile {
  const obj: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawKind = (typeof obj.subject_kind === "string" ? obj.subject_kind : "").trim().toLowerCase();
  const subjectKind: CharacterSubjectKind =
    rawKind === "female" || rawKind === "male" || rawKind === "animal" || rawKind === "other"
      ? rawKind
      : "male";
  const profile: CharacterProfile = {
    subject_kind: subjectKind,
    source_image_asset_id: getStr(obj, "source_image_asset_id"),
  };
  const name = getStr(obj, "name");
  if (name) profile.name = name;
  for (const k of ["wardrobe", "poses", "backdrop", "outfits"] as const) {
    const v = obj[k];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      profile[k] = v as string[];
    }
  }
  if (isFreeformSubject(subjectKind)) {
    const other = getStr(obj, "other");
    if (other) profile.other = other;
    return profile;
  }
  for (const k of ["age", "ethnicity", "height", "build", "bust", "waist", "hips", "face", "hair", "eyes", "skin"] as const) {
    const v = getStr(obj, k);
    if (v) profile[k] = v;
  }
  return profile;
}

function getStr(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v.trim() : "";
}

export type SlotKind = "wardrobe" | "poses" | "backdrop" | "outfits";

interface SlotState {
  assetId: string | null;
  profile: CharacterProfile | null;
  loading: boolean;
  error: string | null;
}

export interface UseCharacterSlotsResult {
  profile: CharacterProfile | null;
  wardrobe: string[];
  poses: string[];
  backdrop: string[];
  outfits: string[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const POLL_MS = 3000;
const MAX_POLLS = 30;
const INITIAL_STATE: SlotState = { assetId: null, profile: null, loading: false, error: null };

export function useCharacterSlots(
  callTool: UseMcpResult["callTool"],
  callState: UseMcpResult["state"],
  assetId: string | null,
  projectSlug: string | undefined,
): UseCharacterSlotsResult {
  const [state, setState] = useState<SlotState>(INITIAL_STATE);
  const [refreshKey, setRefreshKey] = useState(0);
  const callToolRef = useRef(callTool);
  useEffect(() => {
    callToolRef.current = callTool;
  }, [callTool]);

  useEffect(() => {
    if (!assetId || !projectSlug || callState !== "ready" || !assetId.startsWith("char-")) {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const res = await callToolRef.current("read_asset_metadata", {
          asset_id: assetId,
          name: "character",
          project_slug: projectSlug,
        });
        if (cancelled) return;
        if (res.isError) {
          if (attempts >= MAX_POLLS) {
            const content = res.content as Array<{ type: string; text: string }> | undefined;
            setState({
              assetId,
              profile: null,
              loading: false,
              error: content?.[0]?.text ?? "character profile not available",
            });
            return;
          }
          timer = setTimeout(poll, POLL_MS);
          return;
        }
        const content = res.content as Array<{ type: string; text: string }>;
        const raw = JSON.parse(content[0].text) as unknown;
        const parsed = normalizeCharacterProfile(raw);
        setState({ assetId, profile: parsed, loading: false, error: null });
      } catch (e) {
        if (cancelled) return;
        if (attempts >= MAX_POLLS) {
          setState({
            assetId,
            profile: null,
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          });
          return;
        }
        timer = setTimeout(poll, POLL_MS);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [assetId, projectSlug, callState, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  if (state.assetId !== assetId) {
    return {
      profile: null,
      wardrobe: [],
      poses: [],
      backdrop: [],
      outfits: [],
      loading: !!assetId && assetId.startsWith("char-"),
      error: null,
      refresh,
    };
  }
  return {
    profile: state.profile,
    wardrobe: state.profile?.wardrobe ?? [],
    poses: state.profile?.poses ?? [],
    backdrop: state.profile?.backdrop ?? [],
    outfits: state.profile?.outfits ?? [],
    loading: state.loading,
    error: state.error,
    refresh,
  };
}
