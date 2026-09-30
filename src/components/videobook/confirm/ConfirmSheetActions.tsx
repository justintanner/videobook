// The two decisions, in the sheet's top right beside the title that says what
// they act on, rather than at the far end of a body that can scroll. Nothing
// else joins them here: anything optional belongs in the footer.
export function ConfirmSheetActions({
  applyDisabled,
  applyFormId,
  applyLabel,
  busy,
  busyLabel,
  failed,
  onCancel,
}: {
  applyDisabled: boolean
  applyFormId: string
  applyLabel: string
  busy: boolean
  busyLabel: string
  failed: boolean
  onCancel: () => void
}) {
  return (
    <div className="confirm-sheet-actions">
      <button
        type="submit"
        form={applyFormId}
        className="confirm-sheet-apply"
        disabled={busy || applyDisabled}
      >
        {busy
          ? busyLabel
          : (
              <>
                {failed ? 'Retry' : applyLabel} <kbd>↵</kbd>
              </>
            )}
      </button>
      <button type="button" disabled={busy} onClick={onCancel}>
        Cancel <kbd>Esc</kbd>
      </button>
    </div>
  )
}
