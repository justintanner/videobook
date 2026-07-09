export interface SceneMarker {
  timeSec: number;
  label: string;
}

export interface TimeMark {
  timeSec: number;
  label: string;
}

export interface SplitTarget {
  assetId: string;
  atSec?: number;
}
