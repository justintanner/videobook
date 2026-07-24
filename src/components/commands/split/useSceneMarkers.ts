import { useEffect, useState } from 'react';
import type { SceneMarker } from './types';

interface AnalysisScene {
  timestamp?: number;
  description?: string;
}

interface AnalysisJson {
  scenes?: AnalysisScene[];
}

export function useSceneMarkers(
  open: boolean,
  assetId: string | null,
  bookId: string | undefined,
): SceneMarker[] {
  const [markers, setMarkers] = useState<SceneMarker[]>([]);

  useEffect(() => {
    if (!open || !assetId || !bookId) {
      return () => setMarkers([]);
    }
    let cancelled = false;
    fetch(`/files/${bookId}/${assetId}/.original.analysis.json`)
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
  }, [open, assetId, bookId]);

  return markers;
}
