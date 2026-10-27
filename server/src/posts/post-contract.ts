export const POST_PLATFORMS = ["x", "instagram", "tiktok", "youtube", "other"] as const;
export type PostPlatform = typeof POST_PLATFORMS[number];
export const POST_METRIC_NAMES = ["views", "impressions", "likes", "replies", "reposts", "quotes", "bookmarks", "shares", "clicks"] as const;
export type PostMetricName = typeof POST_METRIC_NAMES[number];
export type PostMetrics = Partial<Record<PostMetricName, number | null>>;

export type PostDelivery = "icloud" | "download";

export interface PostDefinition {
  version: 1;
  platform: PostPlatform;
  delivery?: PostDelivery;
  account: string;
  caption: string;
  credits: string;
  notes: string;
  createdAt: string;
  source: {
    cellId: string;
    artifactId: string;
    revision: string | null;
    objectHash: string | null;
    filename: string | null;
    sourceFilename?: string;
    snapshotArtifactId: string | null;
  } | null;
  lineage: Array<{ cellId: string; type: string; label?: string; artifactId?: string; prompt?: string; inputs?: Record<string, unknown> }>;
}

export interface PostMetricSnapshot {
  id?: string;
  observedAt: string;
  source: "x" | "manual";
  values: PostMetrics;
  mediaViews?: number;
  note?: string;
}

export interface PostICloudFile {
  path: string;
  sha256: string;
  size: number;
}

export const POST_STATUSES = ["draft", "uploading", "ready", "scheduled", "posting", "posted", "partially_posted", "failed", "needs_reconciliation"] as const;
export type PostStatus = typeof POST_STATUSES[number];

export interface PostRuntime {
  status: PostStatus;
  url?: string;
  postedAt?: string;
  error?: string | null;
  scheduledFor?: string;
  scheduleId?: string;
  publication?: PostDefinition;
  outbound?: { artifactId: string; filename: string; caption: string; frozenAt: string; revision: string; objectHash: string };
  xRequest?: {
    text: string;
    followups: Array<{ text?: string; image_asset_ids?: string[] }>;
    sourceFollowups?: Array<{ text?: string; image_asset_ids?: string[] }>;
    orientation?: "portrait" | "landscape";
    attachments?: Array<{ artifactId: string; filename: string; revision: string; objectHash: string }>;
  };
  x?: { tweetId: string; mediaId: string; replies: Array<{ tweet_id: string; tweet_url: string; media_ids: string[]; text: string | null; posted_at: string }>; followupError?: { reply_number: number; message: string } | null };
  download?: { completedAt: string };
  icloud?: { folder: string; video?: PostICloudFile; caption?: PostICloudFile; completedAt?: string };
  metrics: PostMetricSnapshot[];
  nextMetricAt?: string | null;
  metricsError?: string | null;
  metricsPaused?: boolean;
}

export interface PostView {
  id: string;
  notebookId: string;
  address: string;
  label: string;
  definition: PostDefinition;
  runtime: PostRuntime;
}
