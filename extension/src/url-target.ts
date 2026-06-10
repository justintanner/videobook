type UrlTargetInput = {
  linkUrl?: string;
  pageUrl?: string;
  tabUrl?: string;
};

export type DownloadVideoArguments = Record<string, unknown> & {
  url: string;
  project_slug: string;
  full: true;
  export_videos: false;
};

function cleanUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function selectDownloadUrl(input: UrlTargetInput): string | null {
  return cleanUrl(input.linkUrl) ?? cleanUrl(input.pageUrl) ?? cleanUrl(input.tabUrl);
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function buildDownloadVideoArguments(url: string, projectSlug: string): DownloadVideoArguments {
  return {
    url,
    project_slug: projectSlug,
    full: true,
    export_videos: false,
  };
}
