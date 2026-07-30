export type BookProjectSummary = {
  bookId: string
  slug: string
  createdAt: number
  artifactCount: number
  notebookCount: number
}

export type BookProjectMutationResult =
  | { ok: true }
  | { ok: false; error: string }

export function formatArtifactCount(count: number): string {
  return count === 1 ? '1 artifact' : `${count} artifacts`
}

export function formatNotebookCount(count: number): string {
  return count === 1 ? '1 notebook' : `${count} notebooks`
}
