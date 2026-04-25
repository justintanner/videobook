import { useState } from "react";
import { ChevronDown, ChevronRight, User, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CharacterProfile } from "@/hooks/useCharacterSlots";

interface CharacterProfilePanelProps {
  profile: CharacterProfile | null;
  loading: boolean;
  error: string | null;
}

const FIELD_ORDER: Array<{ key: keyof CharacterProfile; label: string }> = [
  { key: "name", label: "Name" },
  { key: "age", label: "Age" },
  { key: "gender_presentation", label: "Presentation" },
  { key: "ethnicity", label: "Background" },
  { key: "height", label: "Height" },
  { key: "build", label: "Build" },
  { key: "measurements", label: "Measurements" },
  { key: "face", label: "Face" },
  { key: "hair", label: "Hair" },
  { key: "eyes", label: "Eyes" },
  { key: "skin", label: "Skin" },
  { key: "distinguishing_features", label: "Features" },
  { key: "wardrobe_style", label: "Style" },
  { key: "vibe", label: "Vibe" },
  { key: "backstory", label: "Backstory" },
];

export function CharacterProfilePanel({ profile, loading, error }: CharacterProfilePanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (!profile && !loading && !error) return null;

  return (
    <div className={cn(
      "w-full bg-transparent text-xs font-mono text-violet-100",
    )}>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-2 border-b border-violet-500/30 hover:bg-violet-500/10"
      >
        {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        <User className="w-3 h-3 text-violet-300" />
        <span className="font-bold uppercase tracking-wider text-[10px] text-violet-200">Character</span>
        {loading && <Loader2 className="w-3 h-3 animate-spin ml-auto text-violet-300" />}
      </button>
      {!collapsed && (
        <div className="p-2 space-y-1.5">
          {error && (
            <div className="text-red-300/80 text-[10px]">{error}</div>
          )}
          {loading && !profile && !error && (
            <div className="text-violet-300/60 text-[10px]">Extracting profile…</div>
          )}
          {profile && FIELD_ORDER.map(({ key, label }) => {
            const value = profile[key];
            if (!value || typeof value !== "string" || !value.trim()) return null;
            return (
              <div key={key} className="leading-tight">
                <div className="text-[9px] uppercase tracking-wider text-violet-400/70">{label}</div>
                <div className="text-violet-100 text-[11px]">{value}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
