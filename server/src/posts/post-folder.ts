function folderSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || "book";
}

export function defaultPostFolderName(bookName: string, address: string, postId: string): string {
  return `${folderSegment(bookName)}/post-${address.replace(/^@/u, "")}-${postId.slice(-6)}`;
}

export function icloudFolderError(folder: string): string | null {
  const trimmed = folder.trim().replace(/\/+$/u, "");
  if (!trimmed) return "Choose an iCloud folder.";
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return "Use a folder inside iCloud Drive › Videobook, like my-book/post-a1.";
  if ([...trimmed].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return "Use an iCloud folder without control characters.";
  if (trimmed.split("/").some(segment => segment === ".." || segment === "." || segment === "")) return "Use an iCloud folder without empty, . or .. segments.";
  return null;
}

export interface PostDownload {
  clip_url: string;
  caption_url: string;
  filename: string;
  caption: string;
}

function fileExtension(filename: string): string {
  return /\.[^./]+$/u.exec(filename)?.[0] ?? "";
}

function downloadUrl(bookId: string, artifactId: string, filename: string, saveAs: string): string {
  return `/files/${encodeURIComponent(bookId)}/${encodeURIComponent(artifactId)}/${encodeURIComponent(filename)}?download=${encodeURIComponent(saveAs)}`;
}

export function postDownloadLinks(
  book: { bookId: string; name: string },
  post: { id: string; address: string },
  outbound: { artifactId: string; filename: string; caption: string },
): PostDownload {
  const name = defaultPostFolderName(book.name, post.address, post.id).replaceAll("/", "-");
  const filename = `${name}${fileExtension(outbound.filename)}`;
  return {
    clip_url: downloadUrl(book.bookId, outbound.artifactId, outbound.filename, filename),
    caption_url: downloadUrl(book.bookId, outbound.artifactId, "caption.txt", `${name}.txt`),
    filename,
    caption: outbound.caption,
  };
}
