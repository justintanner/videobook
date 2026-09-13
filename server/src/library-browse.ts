export const LIBRARY_BROWSE_STATUSES = [
  "ready",
  "processing",
  "error",
  "all",
] as const;

export type LibraryBrowseStatus = (typeof LIBRARY_BROWSE_STATUSES)[number];

export type LibraryStatusCounts = {
  ready: number;
  processing: number;
  error: number;
};

export type LibraryBrowsePage = {
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
};

const READY_STATUS = "ready";
const ERROR_STATUS = "error";

export function isLibraryBrowseStatus(
  value: unknown,
): value is LibraryBrowseStatus {
  return value === "ready"
    || value === "processing"
    || value === "error"
    || value === "all";
}

export function isLibraryBrowseRow(asset: { type: string }): boolean {
  return asset.type !== "notebook";
}

export function isProcessingStatus(status: string): boolean {
  return status !== READY_STATUS && status !== ERROR_STATUS;
}

export function matchesBrowseStatus(
  status: string,
  browseStatus: LibraryBrowseStatus,
): boolean {
  if (browseStatus === "all") return true;
  if (browseStatus === "ready") return status === READY_STATUS;
  if (browseStatus === "error") return status === ERROR_STATUS;
  return isProcessingStatus(status);
}

export function emptyStatusCounts(): LibraryStatusCounts {
  return { ready: 0, processing: 0, error: 0 };
}

export function addStatusCounts(
  left: LibraryStatusCounts,
  right: LibraryStatusCounts,
): LibraryStatusCounts {
  return {
    ready: left.ready + right.ready,
    processing: left.processing + right.processing,
    error: left.error + right.error,
  };
}

export function countBrowseStatuses(
  assets: ReadonlyArray<{ status: string }>,
): LibraryStatusCounts {
  const counts = emptyStatusCounts();
  for (const asset of assets) {
    if (asset.status === READY_STATUS) counts.ready += 1;
    else if (asset.status === ERROR_STATUS) counts.error += 1;
    else counts.processing += 1;
  }
  return counts;
}

export function pageLibraryAssets<Asset extends { status: string; type: string }>(
  assets: readonly Asset[],
  input: {
    browseStatus?: LibraryBrowseStatus;
    offset?: number;
    limit?: number;
  },
): {
  matching: Asset[];
  pageAssets: Asset[];
  page: LibraryBrowsePage;
  statusCounts: LibraryStatusCounts;
} {
  const browseStatus = input.browseStatus;
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 200;
  const eligible = browseStatus === undefined
    ? [...assets]
    : assets.filter(isLibraryBrowseRow);
  const statusCounts = countBrowseStatuses(eligible.filter(isLibraryBrowseRow));
  const matching = browseStatus === undefined
    ? eligible
    : eligible.filter((asset) => matchesBrowseStatus(asset.status, browseStatus));
  const pageAssets = matching.slice(offset, offset + limit);
  return {
    matching,
    pageAssets,
    page: {
      offset,
      limit,
      total: matching.length,
      hasMore: offset + pageAssets.length < matching.length,
    },
    statusCounts,
  };
}
