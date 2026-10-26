export const WORKSPACE_ACTION_FORM_ID = 'workspace-action-form'

export function workspaceActionFormValid(): boolean {
  const form = document.getElementById(WORKSPACE_ACTION_FORM_ID)
  return !(form instanceof HTMLFormElement) || form.reportValidity()
}
