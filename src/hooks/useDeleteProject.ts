import { useCallback } from 'react'
import type { UseMcpResult } from 'use-mcp/react'

export interface DeleteProjectResult {
  slug: string
  deleted_at: string
  default_project_slug: string | null
}

export type DeleteProjectResponse =
  | { ok: true; value: DeleteProjectResult }
  | { ok: false; error: string }

export function useDeleteProject(callTool: UseMcpResult['callTool']) {
  const deleteProject = useCallback(
    async (slug: string): Promise<DeleteProjectResponse> => {
      const result = await callTool('delete_project', { project_slug: slug })
      const content = result.content as Array<{ type: string; text: string }>
      if (result.isError) {
        return { ok: false, error: content[0]?.text ?? 'Delete project failed' }
      }
      return { ok: true, value: JSON.parse(content[0].text) as DeleteProjectResult }
    },
    [callTool],
  )

  return { deleteProject }
}
