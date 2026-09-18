import type { ActionSurface } from "./workspace-action-contract.js";

export const WORKSPACE_ACTION_SURFACES: Readonly<Record<ActionSurface, { component: string; trigger: string }>> = {
  slash: { component: "src/components/videobook/RichComposerEditor.tsx", trigger: "Type / in chat; choose a command or alias" },
  launcher: { component: "src/components/videobook/ComposerActionsPanel.tsx", trigger: "Search Actions in the main chat input; choose a command, then submit to continue" },
  button: { component: "src/components/videobook/CommandComposer.tsx", trigger: "Actions beside the chat input; Ctrl+Shift+K / Cmd+Shift+K; on-demand Actions in Library" },
  "cell-menu": { component: "src/components/videobook/NotebookCellContextMenu.tsx", trigger: "Cell or empty-slot menu → More actions" },
  "library-menu": { component: "src/components/videobook/LibraryAssetCard.tsx", trigger: "Media overflow → All media actions" },
  "selection-menu": { component: "src/components/videobook/NotebookToolbar.tsx", trigger: "Selection actions in the notebook toolbar" },
  fullscreen: { component: "src/components/videobook/NotebookMediaFullscreen.tsx", trigger: "More media actions" },
};
