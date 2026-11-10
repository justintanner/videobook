import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { resolveNotebookCellArtifactId } from "videobook-engine";

export type GraphicsCredit = { text: string; platform: string; handle: string; url: string | null };

type SourceSite = { label: string; hosts: readonly string[]; extractors: readonly string[]; handlePath: RegExp | null };
type OriginalSource = { platform?: unknown; uploader?: unknown; webpage_url?: unknown; source_url?: unknown };

const MAX_SOURCE_STEPS = 8;
const HANDLE = /^@?([\p{L}\p{N}._-]{1,64})$/u;

const SOURCE_SITES: readonly SourceSite[] = [
  { label: "TikTok", hosts: ["tiktok.com"], extractors: ["tiktok", "tt"], handlePath: /^\/@([^/]+)/u },
  { label: "YouTube", hosts: ["youtube.com", "youtu.be"], extractors: ["youtube", "yt"], handlePath: /^\/@([^/]+)/u },
  { label: "Instagram", hosts: ["instagram.com"], extractors: ["instagram", "ig"], handlePath: /^\/(?!(?:p|reels?|tv|stories)\/)([^/]+)\/(?:p|reels?|tv)\//u },
  { label: "X", hosts: ["x.com", "twitter.com"], extractors: ["twitter", "x"], handlePath: /^\/(?!i\/)([^/]+)\/status\//u },
  { label: "Facebook", hosts: ["facebook.com", "fb.watch"], extractors: ["facebook", "fb"], handlePath: null },
  { label: "Vimeo", hosts: ["vimeo.com"], extractors: ["vimeo", "vm"], handlePath: null },
  { label: "Reddit", hosts: ["reddit.com"], extractors: ["reddit", "rd"], handlePath: null },
  { label: "Twitch", hosts: ["twitch.tv"], extractors: ["twitch", "tw"], handlePath: null },
  { label: "Dailymotion", hosts: ["dailymotion.com"], extractors: ["dailymotion", "dm"], handlePath: null },
];

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parsedUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hostSite(url: string | null): SourceSite | null {
  const hostname = parsedUrl(url)?.hostname.toLowerCase();
  if (!hostname) return null;
  return SOURCE_SITES.find((site) => site.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) ?? null;
}

function extractorSite(platform: string | null): SourceSite | null {
  const key = platform?.toLowerCase().split(":")[0];
  return key ? SOURCE_SITES.find((site) => site.extractors.includes(key)) ?? null : null;
}

function pathHandle(site: SourceSite, url: string | null): string | null {
  const path = parsedUrl(url)?.pathname;
  const match = path && site.handlePath ? site.handlePath.exec(path) : null;
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function handleText(value: string | null): string | null {
  const match = value ? HANDLE.exec(value) : null;
  return match ? match[1] : null;
}

function creditFrom(original: OriginalSource | null): GraphicsCredit | null {
  if (!original) return null;
  const urls = [text(original.webpage_url), text(original.source_url)];
  const url = urls.find((candidate) => hostSite(candidate) !== null) ?? urls.find((candidate) => candidate !== null) ?? null;
  const site = hostSite(url) ?? extractorSite(text(original.platform));
  if (!site) return null;
  const handle = handleText(pathHandle(site, url)) ?? handleText(text(original.uploader));
  return handle ? { text: `${site.label}/@${handle}`, platform: site.label, handle, url } : null;
}

async function originalSource(engine: Engine, artifactId: string): Promise<OriginalSource | null> {
  const read = await engine.metadata.artifacts.read<OriginalSource>(artifactId, "original");
  return read.ok && read.value !== null && typeof read.value === "object" ? read.value : null;
}

function stringInput(cell: NotebookCell, key: string): string | null {
  const value = cell.inputs?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cellSource(notebook: NotebookDocument, cell: NotebookCell): string | null {
  const direct = stringInput(cell, "sourceArtifactId") ?? stringInput(cell, "source_asset_id");
  if (direct) return direct;
  const sourceCellId = stringInput(cell, "sourceCellId");
  const sourceCell = sourceCellId ? notebook.cells.find((candidate) => candidate.id === sourceCellId) : undefined;
  return sourceCell ? resolveNotebookCellArtifactId(notebook, sourceCell) ?? null : null;
}

function parentArtifact(engine: Engine, artifactId: string): string | null {
  for (const notebook of engine.notebooks.list()) {
    for (const cell of notebook.cells) {
      if (cell.outputArtifactId !== artifactId) continue;
      const parent = cellSource(notebook, cell);
      if (parent && parent !== artifactId) return parent;
    }
  }
  return null;
}

export async function sourceCredit(engine: Engine, artifactId: string): Promise<GraphicsCredit | null> {
  const seen = new Set<string>();
  let current: string | null = artifactId;
  for (let step = 0; current !== null && step <= MAX_SOURCE_STEPS && !seen.has(current); step += 1) {
    seen.add(current);
    const credit = creditFrom(await originalSource(engine, current));
    if (credit) return credit;
    current = parentArtifact(engine, current);
  }
  return null;
}
