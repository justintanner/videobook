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
