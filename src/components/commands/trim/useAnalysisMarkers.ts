import { useEffect, useState } from 'react';
import type { SnapMarker } from './types';

interface AnalysisScene {
  timestamp?: number;
  description?: string;
}

interface AnalysisJson {
  scenes?: AnalysisScene[];
}

export function useAnalysisMarkers(
  open: boolean,
  assetId: string | null,
  projectSlug: string | undefined,
): SnapMarker[] {
  const [markers, setMarkers] = useState<SnapMarker[]>([]);

  useEffect(() => {
    if (!open || !assetId || !projectSlug) {
      return () => setMarkers([]);
    }
    let cancelled = false;
    fetch(`/files/${projectSlug}/${assetId}/.original.analysis.json`)
      .then((res) => {
        if (!res.ok) throw new Error('no analysis');
        return res.json() as Promise<AnalysisJson>;
      })
      .then((data) => {
        if (cancelled) return;
        const scenes = (data?.scenes ?? []).filter(
          (s): s is AnalysisScene & { timestamp: number } => typeof s.timestamp === 'number',
        );
        setMarkers(scenes.map((s) => ({ timeSec: s.timestamp, label: s.description ?? '' })));
      })
      .catch(() => {
        if (!cancelled) setMarkers([]);
      });
    return () => { cancelled = true; };
  }, [open, assetId, projectSlug]);

  return markers;
}
