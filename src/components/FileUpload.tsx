import { useState } from "react";
import type { UseMcpResult } from "use-mcp/react";
import { useListProjects } from "../hooks/useListProjects";
import { useUploadFile } from "../hooks/useUploadFile";
import { cn } from "@/lib/utils";
import { DISABLED_STATE, FOCUS_RING_INPUT } from "@/components/ui/interaction-states";

const ACCEPT = ".mp4,.mov,.webm,.avi,.mkv,.jpg,.jpeg,.png,.gif,.webp,.svg,.mp3,.wav,.aac,.flac,.ogg,.md";

const buttonClass = cn(
  "rounded border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary transition-colors hover:bg-primary/20",
  DISABLED_STATE
);

interface FileUploadProps {
  callTool: UseMcpResult["callTool"];
}

export function FileUpload({ callTool }: FileUploadProps) {
  const { projects, loading: loadingProjects, error: projectsError, refresh } = useListProjects(callTool);
  const { upload, uploading, result, error: uploadError } = useUploadFile();

  const [selectedSlug, setSelectedSlug] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const canUpload = selectedSlug && file && !uploading;

  const handleUpload = () => {
    if (canUpload) {
      upload(selectedSlug, file);
    }
  };

  return (
    <section className="mt-6 flex flex-col gap-3">
      <h2 className="font-mono text-base font-bold tracking-wider text-foreground">Upload File</h2>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={refresh} disabled={loadingProjects} className={buttonClass}>
          {loadingProjects ? "Loading..." : "Load Projects"}
        </button>
        {projects.length > 0 && (
          <select
            value={selectedSlug}
            onChange={(e) => setSelectedSlug(e.target.value)}
            className={cn(
              "rounded border border-input bg-card px-2 py-1.5 font-mono text-xs text-foreground",
              FOCUS_RING_INPUT
            )}
          >
            <option value="">Select project...</option>
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>{p.slug}</option>
            ))}
          </select>
        )}
        {projectsError && (
          <span className="font-mono text-xs text-destructive">{projectsError}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept={ACCEPT}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="font-mono text-xs text-muted-foreground file:mr-2 file:rounded file:border file:border-border file:bg-card file:px-2 file:py-1 file:font-mono file:text-xs file:text-foreground hover:file:bg-card/70"
        />
        <button onClick={handleUpload} disabled={!canUpload} className={buttonClass}>
          {uploading ? "Uploading..." : "Upload"}
        </button>
      </div>

      {result && (
        <div className="rounded border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 font-mono text-xs text-foreground">
          Uploaded: <code className="text-emerald-300">{result.assetId}</code> / <code className="text-emerald-300">{result.filename}</code>
        </div>
      )}

      {uploadError && (
        <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
          {uploadError}
        </div>
      )}
    </section>
  );
}
