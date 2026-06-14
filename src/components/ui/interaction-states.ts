// Canonical interaction-state utility classes. One source of truth so loading,
// disabled, and focus affordances read the same across every interactive control.
//
// Two-tier focus rule: native inputs/selects use a 1px ring (FOCUS_RING_INPUT);
// interactive buttons use a 2px ring with offset (FOCUS_RING_BUTTON), matching
// the established CommandButton / GenerateCommandButton treatment. The ring
// *color* is supplied per-component (e.g. a domain or tone class).

/** Operation in-flight while the control stays interactive (e.g. queueable buttons). */
export const LOADING_STATE = 'opacity-80 cursor-wait';

/** Control is disabled / not actionable. */
export const DISABLED_STATE = 'disabled:opacity-50 disabled:cursor-not-allowed';

/** Focus ring for interactive buttons. */
export const FOCUS_RING_BUTTON =
  'focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-black focus-visible:outline-none';

/** Focus ring for native inputs / selects. */
export const FOCUS_RING_INPUT = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
