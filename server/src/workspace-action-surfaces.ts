import type { ActionSurface } from "./workspace-action-contract.js";

export const WORKSPACE_ACTION_SURFACES: Readonly<Record<ActionSurface, { component: string; trigger: string }>> = {
  slash: { component: "src/components/videobook/CommandComposer.tsx", trigger: "Type / in chat; choose a command or alias" },
  launcher: { component: "src/components/videobook/WorkspaceActionsDialog.tsx", trigger: "Search the Actions dialog" },
  button: { component: "src/App.tsx", trigger: "Actions in the header; Ctrl+Shift+K / Cmd+Shift+K" },
  "cell-menu": { component: "src/components/videobook/NotebookCellContextMenu.tsx", trigger: "Cell or empty-slot menu → More actions" },
  "library-menu": { component: "src/components/videobook/LibraryAssetCard.tsx", trigger: "Media overflow → All media actions" },
  "selection-menu": { component: "src/components/videobook/NotebookToolbar.tsx", trigger: "Selection actions in the notebook toolbar" },
  inspector: { component: "src/App.tsx", trigger: "Inspector actions" },
  fullscreen: { component: "src/components/videobook/NotebookMediaFullscreen.tsx", trigger: "More media actions" },
};
