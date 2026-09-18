export interface SubjectWorkspaceState {
  /* The workspace is a column of its own beside the picture unless it has been
     portaled into the chat dock, where its height is the picture's loss. */
  docked: boolean
  /* What the viewer last asked for with the collapse control; null while they
     have not asked and the workspace follows the work instead. */
  requested: boolean | null
  working: boolean
  hasContent: boolean
}

/* Docked, the workspace rests as a single header row so a tall picture keeps
   the stage. It opens itself while a tool runs or once there is something to
   act on, and an explicit ask — either way — outranks that. Undocked it has a
   column of its own, where its height costs the picture nothing. */
export function subjectWorkspaceExpanded(state: SubjectWorkspaceState): boolean {
  if (!state.docked) return true
  if (state.requested !== null) return state.requested
  return state.working || state.hasContent
}
