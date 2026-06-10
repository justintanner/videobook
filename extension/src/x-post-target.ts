const STATUS_PATH = /^\/([^/]+)\/status\/(\d+)/;

function isXHost(hostname: string): boolean {
  return hostname === "x.com" || hostname === "twitter.com" || hostname.endsWith(".x.com") || hostname.endsWith(".twitter.com");
}

export function normalizeXStatusUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    if (!isXHost(url.hostname)) return null;

    const match = url.pathname.match(STATUS_PATH);
    if (!match) return null;

    return `${url.origin}/${match[1]}/status/${match[2]}`;
  } catch {
    return null;
  }
}

export function selectXPostUrl(anchorHrefs: Iterable<string>, pageUrl: string): string | null {
  for (const href of anchorHrefs) {
    const normalized = normalizeXStatusUrl(href, pageUrl);
    if (normalized) return normalized;
  }

  return normalizeXStatusUrl(pageUrl, pageUrl);
}
