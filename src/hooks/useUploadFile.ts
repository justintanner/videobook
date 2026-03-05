import { useState, useCallback } from "react";
import type { UseMcpResult } from "use-mcp/react";

interface UploadResult {
  assetId: string;
  path: string;
  filename: string;
}

interface UseUploadFileResult {
  upload: (projectSlug: string, file: File) => void;
  uploading: boolean;
  result: UploadResult | undefined;
  error: string | undefined;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(",")[1]);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function useUploadFile(callTool: UseMcpResult["callTool"]): UseUploadFileResult {
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | undefined>();
  const [error, setError] = useState<string | undefined>();

  const upload = useCallback(async (projectSlug: string, file: File) => {
    setUploading(true);
    setResult(undefined);
    setError(undefined);
    try {
      const data = await fileToBase64(file);
      const toolResult = await callTool("upload_file", {
        project_slug: projectSlug,
        filename: file.name,
        data,
      });
      if (toolResult.isError) {
        const content = toolResult.content as Array<{ type: string; text: string }>;
        setError(content[0].text);
      } else {
        const content = toolResult.content as Array<{ type: string; text: string }>;
        setResult(JSON.parse(content[0].text));
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }, [callTool]);

  return { upload, uploading, result, error };
}
