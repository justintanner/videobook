import { useState } from "react";
import { ChevronDown, ChevronRight, User, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { trimToHeadClause } from "@/lib/character";
import type { CharacterProfile } from "@/hooks/useCharacterSlots";

interface CharacterProfilePanelProps {
  profile: CharacterProfile | null;
  loading: boolean;
  error: string | null;
}

type ProfileKey = keyof CharacterProfile;

const SHORT_FIELDS: Array<{ key: ProfileKey; label: string }> = [
  { key: "name", label: "Name" },
  { key: "age", label: "Age" },
  { key: "gender_presentation", label: "Presentation" },
  { key: "ethnicity", label: "Background" },
  { key: "height", label: "Height" },
  { key: "build", label: "Build" },
];

const MEASUREMENT_FIELDS: Array<{ key: ProfileKey; label: string }> = [
  { key: "bust", label: "Bust" },
  { key: "waist", label: "Waist" },
  { key: "hips", label: "Hips" },
  { key: "glutes", label: "Glutes" },
];

const LONG_FIELDS: Array<{ key: ProfileKey; label: string }> = [
  { key: "face", label: "Face" },
  { key: "hair", label: "Hair" },
  { key: "eyes", label: "Eyes" },
  { key: "skin", label: "Skin" },
  { key: "distinguishing_features", label: "Features" },
];

function getStr(profile: CharacterProfile, key: ProfileKey): string {
  const v = profile[key];
  return typeof v === "string" ? v : "";
}

export function CharacterProfilePanel({ profile, loading, error }: CharacterProfilePanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (!profile && !loading && !error) return null;

  return (
    <div className="w-full bg-transparent text-xs font-mono text-violet-100">
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
        <div className="p-2 space-y-2.5">
          {error && <div className="text-red-300/80 text-[10px]">{error}</div>}
          {loading && !profile && !error && (
            <div className="text-violet-300/60 text-[10px]">Extracting profile…</div>
          )}

          {profile && (
            <>
              <div className="space-y-1.5">
                {SHORT_FIELDS.map(({ key, label }) => {
                  const value = getStr(profile, key);
                  if (!value.trim()) return null;
                  return <Field key={key} label={label} value={value} />;
                })}
              </div>

              <div className="border-t border-violet-500/20 pt-2">
                <div className="text-[9px] uppercase tracking-wider text-violet-300/80 mb-1.5">
                  Measurements
                </div>
                <div className="space-y-1.5">
                  {MEASUREMENT_FIELDS.map(({ key, label }) => (
                    <Field key={key} label={label} value={getStr(profile, key) || "—"} />
                  ))}
                </div>
              </div>

              <div className="border-t border-violet-500/20 pt-2 space-y-1.5">
                {LONG_FIELDS.map(({ key, label }) => {
                  const value = getStr(profile, key);
                  if (!value.trim()) return null;
                  return (
                    <Field
                      key={key}
                      label={label}
                      value={trimToHeadClause(value)}
                      title={value}
                    />
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  compact,
  title,
}: {
  label: string;
  value: string;
  compact?: boolean;
  title?: string;
}) {
  return (
    <div className={cn("leading-tight", compact && "min-w-0")} title={title}>
      <div className="text-[9px] uppercase tracking-wider text-violet-400/70">{label}</div>
      <div className={cn("text-violet-100", compact ? "text-[10px] truncate" : "text-[11px]")}>
        {value}
      </div>
    </div>
  );
}
