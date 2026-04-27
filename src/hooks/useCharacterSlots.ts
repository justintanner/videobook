import { useCallback, useEffect, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";

export type CharacterSubjectKind = "human" | "animal";

export interface CharacterProfile {
  name?: string;
  subject_kind: CharacterSubjectKind;
  age: string;
  sex: string;
  gender_presentation?: string;
  ethnicity: string;
  height: string;
  build: string;
  bust: string;
  waist: string;
  hips: string;
  glutes: string;
  face: string;
  hair: string;
  eyes: string;
  skin: string;
  distinguishing_features: string;
  source_image_asset_id: string;
  wardrobe?: string[];
  poses?: string[];
  backdrop?: string[];
  outfits?: string[];
}

export type LegacyCharacterProfile = Omit<CharacterProfile, "subject_kind" | "sex"> & {
  subject_kind?: string;
  sex?: string;
  gender_presentation?: string;
};

function normalizeSubjectKindValue(value: string | undefined): CharacterSubjectKind {
  return value?.trim().toLowerCase() === "animal" ? "animal" : "human";
}

function normalizeSexValue(value: string): string {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (["masculine", "man", "male-presenting", "male presenting"].includes(lower)) return "male";
  if (["feminine", "woman", "female-presenting", "female presenting"].includes(lower)) return "female";
  return trimmed;
}

export function normalizeCharacterProfile(profile: LegacyCharacterProfile): CharacterProfile {
  const subjectKind = normalizeSubjectKindValue(profile.subject_kind);
  const rawSex = profile.sex?.trim() ? profile.sex : profile.gender_presentation ?? "";
  return {
    name: profile.name,
    subject_kind: subjectKind,
    age: profile.age,
    sex: normalizeSexValue(rawSex),
    ethnicity: profile.ethnicity,
    height: profile.height,
    build: profile.build,
    bust: profile.bust,
    waist: profile.waist,
    hips: profile.hips,
    glutes: profile.glutes,
    face: profile.face,
    hair: profile.hair,
    eyes: profile.eyes,
    skin: profile.skin,
    distinguishing_features: profile.distinguishing_features,
    source_image_asset_id: profile.source_image_asset_id,
    wardrobe: profile.wardrobe,
    poses: profile.poses,
    backdrop: profile.backdrop,
    outfits: profile.outfits,
  };
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
        const parsed = JSON.parse(content[0].text) as LegacyCharacterProfile;
        setState({ assetId, profile: normalizeCharacterProfile(parsed), loading: false, error: null });
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
