import { useCallback, useEffect, useMemo, useState } from 'react';
import { Tags, Loader2, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import type { UseMcpResult } from 'use-mcp/react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';
import { useMountKey } from '@/contexts/MountKeyContext';
import { CloseButton } from '@/components/ui/CloseButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ViewerToolbar } from './viewer-shared';
import {
  toEditableRows,
  mergeRevalidated,
  editRowName,
  toggleRowIncluded,
  hasDirtyRows,
  canConfirm,
  buildRevalidatePayload,
  buildApplyPayload,
  previewTargetSlug,
  statusLabel,
  type EditableRow,
} from './rename-all-helpers';
import type {
  RenameAllDryRunResponse,
  RenameAllApplyResult,
} from './rename-all-server-types';

type TextContent = Array<{ type: string; text: string }>;

interface RenameAllPanelProps {
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  onApplied: () => void;
  onClose: () => void;
}

type Phase = "loading" | "ready" | "revalidating" | "applying" | "done";

export function RenameAllPanel({ projectSlug, callTool, onApplied, onClose }: RenameAllPanelProps) {
  useMountKey("viewer");
  const [phase, setPhase] = useState<Phase>("loading");
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<RenameAllApplyResult | null>(null);

  const applyDryRunResult = useCallback(
    (result: { isError?: boolean; content: TextContent }) => {
      if (result.isError) {
        setError(result.content[0]?.text ?? "Dry run failed");
        setPhase("ready");
        return;
      }
      try {
        const parsed = JSON.parse(result.content[0].text) as RenameAllDryRunResponse;
        setRows(toEditableRows(parsed.rows));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to parse dry run");
      }
      setPhase("ready");
    },
    [],
  );

  const fetchSuggestions = useCallback(async () => {
    try {
      const result = await callTool("rename_all", {
        project_slug: projectSlug,
        dry_run: true,
      });
      applyDryRunResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dry run failed");
      setPhase("ready");
    }
  }, [callTool, projectSlug, applyDryRunResult]);

  const runDryRun = useCallback(async () => {
    setPhase("loading");
    setError(null);
    await fetchSuggestions();
  }, [fetchSuggestions]);

  useEffect(() => {
    const cancelled = { current: false };
    void (async () => {
      const result = await callTool("rename_all", {
        project_slug: projectSlug,
        dry_run: true,
      });
      if (cancelled.current) return;
      applyDryRunResult(result);
    })();
    return () => { cancelled.current = true; };
  }, [callTool, projectSlug, applyDryRunResult]);

  const occupiedIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      set.add(r.current_slug);
      if (r.status === "renamable") set.add(r.target_asset_id);
    }
    return set;
  }, [rows]);

  const revalidate = useCallback(async () => {
    setPhase("revalidating");
    try {
      const payload = buildRevalidatePayload(rows);
      const result = await callTool("rename_all", {
        project_slug: projectSlug,
        dry_run: true,
        renames: payload,
      });
      if (result.isError) {
        const text = (result.content as TextContent)[0]?.text ?? "Revalidation failed";
        setError(text);
        setPhase("ready");
        return;
      }
      const parsed = JSON.parse(
        (result.content as TextContent)[0].text,
      ) as RenameAllDryRunResponse;
      setRows((prev) => mergeRevalidated(prev, parsed.rows));
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revalidation failed");
      setPhase("ready");
    }
  }, [callTool, projectSlug, rows]);

  const confirm = useCallback(async () => {
    setPhase("applying");
    setError(null);
    try {
      const payload = buildApplyPayload(rows);
      const result = await callTool("rename_all", {
        project_slug: projectSlug,
        dry_run: false,
        renames: payload,
      });
      if (result.isError) {
        const text = (result.content as TextContent)[0]?.text ?? "Apply failed";
        setError(text);
        setPhase("ready");
        return;
      }
      const parsed = JSON.parse(
        (result.content as TextContent)[0].text,
      ) as RenameAllApplyResult;
      setApplied(parsed);
      setPhase("done");
      const renamed = parsed.applied.filter((a) => a.renamed).length;
      toast({
        title: `Renamed ${renamed} asset${renamed === 1 ? "" : "s"}`,
        duration: 3000,
      });
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply failed");
      setPhase("ready");
    }
  }, [callTool, projectSlug, rows, onApplied]);

  const dirty = hasDirtyRows(rows);
  const confirmable = canConfirm(rows);
  const renamableCount = rows.filter((r) => r.included && r.status === "renamable").length;

  return (
    <div className="flex-1 min-w-0 flex items-center justify-center overflow-hidden">
      <div className="w-full h-full min-w-0 relative">
        <div className="absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
          <ViewerToolbar
            left={
              <span className="flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-bold text-cyan-300/90 drop-shadow-[0_0_4px_rgba(45,212,191,0.5)]">
                <Tags className="w-3.5 h-3.5" />
                <span>RENAME ALL</span>
              </span>
            }
            slug="dry run + apply"
            right={<CloseButton tone="cyan" onClick={onClose} />}
          />

          <div
            className="flex-1 min-w-0 overflow-y-auto scrollbar-domain"
            style={{ "--scrollbar-rgb": "45, 212, 191" } as React.CSSProperties}
          >
            <div className="w-full min-w-0 px-4 sm:px-6 py-5">
              {error && (
                <div className="mb-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm font-mono text-red-300">
                  {error}
                </div>
              )}

              {phase === "loading" && (
                <div className="h-full flex items-center justify-center py-16">
                  <div className="flex items-center gap-3">
                    <Loader2 className="w-4 h-4 animate-spin text-cyan-400/60" />
                    <span className="text-sm font-mono text-muted-foreground/60">
                      Generating name suggestions...
                    </span>
                  </div>
                </div>
              )}

              {phase === "done" && applied && (
                <ApplySummary result={applied} onDone={onClose} />
              )}

              {(phase === "ready" || phase === "revalidating" || phase === "applying") && rows.length === 0 && (
                <div className="h-full flex items-center justify-center py-16">
                  <EmptyState size="md">No renamable assets with context found</EmptyState>
                </div>
              )}

              {(phase === "ready" || phase === "revalidating" || phase === "applying") && rows.length > 0 && (
                <>
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-xs font-mono text-muted-foreground/60">
                      {rows.length} asset{rows.length === 1 ? "" : "s"} reviewed ·{" "}
                      <span className="text-cyan-300">{renamableCount}</span> queued
                    </p>
                    <button
                      type="button"
                      onClick={() => void runDryRun()}
                      disabled={phase !== "ready"}
                      className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground/60 hover:text-cyan-300 disabled:opacity-40 transition-colors"
                    >
                      <RefreshCw className="w-3 h-3" />
                      Regenerate
                    </button>
                  </div>

                  <div className="flex flex-col gap-2">
                    {rows.map((row) => (
                      <RenameRowCard
                        key={row.asset_id}
                        row={row}
                        occupiedIds={occupiedIds}
                        disabled={phase !== "ready"}
                        onToggleIncluded={() =>
                          setRows((prev) => toggleRowIncluded(prev, row.asset_id))
                        }
                        onEditName={(name) =>
                          setRows((prev) => editRowName(prev, row.asset_id, name))
                        }
                      />
                    ))}
                  </div>

                  <div className="sticky bottom-0 mt-4 -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 bg-black/70 border-t border-zinc-800/60 flex items-center justify-between gap-3">
                    <div className="flex flex-col">
                      {dirty ? (
                        <span className="flex items-center gap-1.5 text-xs font-mono text-amber-300/90">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          Revalidate edits before confirming
                        </span>
                      ) : (
                        <span className="text-xs font-mono text-muted-foreground/50">
                          {confirmable
                            ? `${renamableCount} rename${renamableCount === 1 ? "" : "s"} ready`
                            : "Resolve conflicts to confirm"}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {dirty && (
                        <button
                          type="button"
                          onClick={() => void revalidate()}
                          disabled={phase === "revalidating"}
                          className={cn(
                            "h-8 px-3 flex items-center gap-1.5 rounded text-xs font-mono font-bold uppercase tracking-wider",
                            "text-amber-200 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/50",
                            "transition-colors duration-150 disabled:opacity-50",
                          )}
                        >
                          {phase === "revalidating" ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                          Revalidate
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void confirm()}
                        disabled={!confirmable || phase === "applying"}
                        className={cn(
                          "h-8 px-4 flex items-center gap-1.5 rounded text-xs font-mono font-bold uppercase tracking-wider",
                          "text-cyan-100 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/60",
                          "transition-colors duration-150",
                          "disabled:opacity-40 disabled:cursor-not-allowed",
                        )}
                      >
                        {phase === "applying" ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        )}
                        Confirm & Apply
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RenameRowCard({
  row,
  occupiedIds,
  disabled,
  onToggleIncluded,
  onEditName,
}: {
  row: EditableRow;
  occupiedIds: Set<string>;
  disabled: boolean;
  onToggleIncluded: () => void;
  onEditName: (name: string) => void;
}) {
  const liveTarget = row.dirty
    ? previewTargetSlug(row.draftName, row.asset_id, occupiedIds)
    : row.target_asset_id;

  const isConflict = row.status === "conflict";
  const isSkipped = row.status === "skipped";

  return (
    <div
      className={cn(
        "grid grid-cols-[auto_1fr_1fr] gap-3 items-center rounded border px-3 py-2.5 transition-colors",
        isConflict
          ? "border-red-500/40 bg-red-500/5"
          : isSkipped
            ? "border-zinc-800/60 bg-zinc-900/30 opacity-60"
            : row.included
              ? "border-cyan-500/30 bg-cyan-500/5"
              : "border-zinc-800/60 bg-zinc-900/20",
      )}
    >
      <button
        type="button"
        onClick={onToggleIncluded}
        disabled={isSkipped || disabled}
        className={cn(
          "w-5 h-5 rounded border flex items-center justify-center shrink-0 transition-colors",
          row.included
            ? "bg-cyan-500/40 border-cyan-400/70 text-cyan-100"
            : "border-zinc-600 text-transparent hover:border-cyan-400/50",
          "disabled:cursor-not-allowed disabled:opacity-40",
        )}
        aria-label={row.included ? "Exclude row" : "Include row"}
      >
        {row.included && <CheckCircle2 className="w-3.5 h-3.5" />}
      </button>

      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/40">
          {row.type} · current
        </span>
        <span className="text-sm font-mono text-zinc-200 truncate" title={row.current_slug}>
          {row.current_slug}
        </span>
        <span className="text-xs font-mono text-muted-foreground/50 truncate">
          {row.current_name}
        </span>
      </div>

      <div className="min-w-0 flex flex-col gap-0.5">
        {isSkipped ? (
          <span className="text-xs font-mono text-muted-foreground/40 italic">
            {row.reason ?? "skipped"}
          </span>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/40">
                proposed
              </span>
              <span
                className={cn(
                  "text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded",
                  isConflict
                    ? "text-red-300 bg-red-500/15"
                    : row.status === "unchanged"
                      ? "text-zinc-400 bg-zinc-700/30"
                      : "text-cyan-300 bg-cyan-500/15",
                )}
              >
                {statusLabel(row)}
              </span>
            </div>
            <input
              type="text"
              value={row.draftName}
              onChange={(e) => onEditName(e.target.value)}
              disabled={disabled}
              className={cn(
                "w-full bg-transparent border-b border-zinc-700/60 focus:border-cyan-400/70",
                "text-sm font-mono text-zinc-100 px-0 py-0.5 outline-none",
                "disabled:opacity-60",
                row.dirty && "border-amber-400/60 text-amber-100",
              )}
            />
            <span
              className={cn(
                "text-xs font-mono truncate",
                row.dirty ? "text-amber-300/70" : "text-cyan-400/60",
              )}
              title={liveTarget}
            >
              → {liveTarget}
            </span>
            {isConflict && row.reason && (
              <span className="text-[10px] font-mono text-red-400/80 truncate">
                {row.reason}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ApplySummary({
  result,
  onDone,
}: {
  result: RenameAllApplyResult;
  onDone: () => void;
}) {
  const succeeded = result.applied.filter((a) => a.renamed);
  const failed = result.applied.filter((a) => !a.renamed);

  return (
    <div className="flex flex-col gap-4 py-8">
      <div className="flex items-center gap-2 text-cyan-300">
        <CheckCircle2 className="w-5 h-5" />
        <span className="text-sm font-mono font-bold uppercase tracking-wider">
          Applied {succeeded.length} rename{succeeded.length === 1 ? "" : "s"}
        </span>
      </div>

      {result.references_updated && (
        <p className="text-xs font-mono text-muted-foreground/60">
          Updated timeline slots, OSG metadata, and plan references.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        {succeeded.map((a) => (
          <div
            key={a.asset_id}
            className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center text-xs font-mono px-3 py-1.5 rounded border border-zinc-800/60 bg-zinc-900/30"
          >
            <span className="text-zinc-400 truncate">{a.asset_id}</span>
            <span className="text-cyan-400/60">→</span>
            <span className="text-cyan-200 truncate">{a.new_asset_id}</span>
          </div>
        ))}
      </div>

      {failed.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-mono uppercase tracking-wider text-red-400/80">
            {failed.length} failed
          </span>
          {failed.map((a) => (
            <div
              key={a.asset_id}
              className="text-xs font-mono px-3 py-1.5 rounded border border-red-500/30 bg-red-500/5 text-red-300"
            >
              {a.asset_id}: {a.error}
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onDone}
        className="self-start h-8 px-4 rounded text-xs font-mono font-bold uppercase tracking-wider text-cyan-100 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/60 transition-colors"
      >
        Done
      </button>
    </div>
  );
}
