export interface TrendingSchedule {
  scheduleId: string;
  platform: "tiktok";
  country: string;
  timezone: string;
  cutoffLocalTime: string;
  samplesPerDay: number;
  windowHours: number;
  topN: number;
  window: "trending" | "posted";
  excludePromoted: boolean;
  ranking: "views" | "consensus";
  sources: { id: string; options?: Record<string, unknown> }[];
  downstream: { transcribe: boolean; translateTo: string[]; analyze: boolean };
  substituteFailures: boolean;
  retentionDays: number;
  archiveTopClips?: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface Sighting {
  platform: "tiktok";
  videoId: string;
  url: string;
  author: { handle: string; id?: string; nickname?: string; followers?: number };
  caption: string;
  language?: string;
  originRegion?: string;
  createdAt: string;
  metrics: { views: number; likes: number; comments?: number; shares?: number; saves?: number };
  windowViews?: number;
  fallback?: boolean;
  music?: { id?: string; title: string; author?: string };
  isAd?: boolean;
  source: string;
  sourceRank: number;
  observedAt: string;
}

export interface SourceHealth {
  lastOk?: string;
  lastError?: string;
  lastCapturedAt?: string;
  retryAfter?: string;
}

export interface RankedVideo extends Sighting {
  rank: number;
  sources: string[];
  fallback: boolean;
}

export interface TrendingLedger {
  sightings: Sighting[];
  sourceHealth: Record<string, SourceHealth>;
  completedSlots: string[];
  sourceDetails?: Record<string, { capturedAt: string; longest: unknown[]; sounds: unknown[]; hashtags: unknown[] }>;
}

export interface TrendingRunRecord {
  date: string;
  cutAt: string;
  dayBookId: string;
  videos: RankedVideo[];
  completed?: boolean;
  notebookId?: string;
  downloads: {
    videoId: string;
    artifactId?: string;
    jobId?: string;
    queueJobId?: number;
    attempts?: number;
    nextRetryAt?: string;
    status: "pending" | "completed" | "failed";
    error?: string;
    archivedAt?: string;
  }[];
  spend: number;
  errors: string[];
}

export interface TrendingHistoryEntry extends TrendingRunRecord {
  dayBookName: string;
  retainedAt: string;
  deletedAt?: string;
}

export interface TrendingRetentionState {
  lastDate: string;
  lastRunAt: string;
  deleted: { date: string; bookId: string; name: string }[];
  prunedLedgers: string[];
  errors: string[];
}
