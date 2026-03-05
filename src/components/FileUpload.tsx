import { useState } from "react";
import type { UseMcpResult } from "use-mcp/react";
import { useListProjects } from "../hooks/useListProjects";
import { useUploadFile } from "../hooks/useUploadFile";

const ACCEPT = ".mp4,.mov,.webm,.avi,.mkv,.jpg,.jpeg,.png,.gif,.webp,.svg,.mp3,.wav,.aac,.flac,.ogg,.md";

interface FileUploadProps {
  callTool: UseMcpResult["callTool"];
}

export function FileUpload({ callTool }: FileUploadProps) {
  const { projects, loading: loadingProjects, error: projectsError, refresh } = useListProjects(callTool);
  const { upload, uploading, result, error: uploadError } = useUploadFile(callTool);

  const [selectedSlug, setSelectedSlug] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const canUpload = selectedSlug && file && !uploading;

  const handleUpload = () => {
    if (canUpload) {
      upload(selectedSlug, file);
    }
  };

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>Upload File</h2>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem" }}>
        <button onClick={refresh} disabled={loadingProjects} style={{ fontSize: "0.8rem", padding: "0.3em 0.8em" }}>
          {loadingProjects ? "Loading..." : "Load Projects"}
        </button>
        {projects.length > 0 && (
          <select
            value={selectedSlug}
            onChange={(e) => setSelectedSlug(e.target.value)}
            style={{ fontSize: "0.85rem", padding: "0.3em 0.5em" }}
          >
            <option value="">Select project...</option>
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>{p.slug}</option>
            ))}
          </select>
        )}
        {projectsError && (
          <span style={{ color: "#ef4444", fontSize: "0.8rem" }}>{projectsError}</span>
        )}
      </div>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem" }}>
        <input
          type="file"
          accept={ACCEPT}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          style={{ fontSize: "0.85rem" }}
        />
        <button onClick={handleUpload} disabled={!canUpload} style={{ fontSize: "0.8rem", padding: "0.3em 0.8em" }}>
          {uploading ? "Uploading..." : "Upload"}
        </button>
      </div>

      {result && (
        <div style={{
          padding: "0.5rem 0.75rem",
          borderRadius: 6,
          background: "rgba(34,197,94,0.1)",
          border: "1px solid rgba(34,197,94,0.3)",
          fontSize: "0.85rem",
        }}>
          Uploaded: <code>{result.assetId}</code> / <code>{result.filename}</code>
        </div>
      )}

      {uploadError && (
        <div style={{
          padding: "0.5rem 0.75rem",
          borderRadius: 6,
          background: "rgba(239,68,68,0.1)",
          border: "1px solid rgba(239,68,68,0.3)",
          fontSize: "0.85rem",
          color: "#ef4444",
        }}>
          {uploadError}
        </div>
      )}
    </section>
  );
}
