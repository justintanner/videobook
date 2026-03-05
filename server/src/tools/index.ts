import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { registerApiStatusTool } from "./api-status.js";
import { registerCreateProjectTool } from "./create-project.js";
import { registerListProjectsTool } from "./list-projects.js";
import { registerGetDefaultProjectTool } from "./get-default-project.js";
import { registerUploadFileTool } from "./upload-file.js";
import { registerAssetManifestTool } from "./asset-manifest.js";
import { registerDeleteAssetTool } from "./delete-asset.js";
import { registerRenameAssetTool } from "./rename-asset.js";
import { registerDuplicateAssetTool } from "./duplicate-asset.js";
import { registerExportAssetTool } from "./export-asset.js";

export function registerAllTools(server: McpServer, fs: ClipfirstFs): void {
  registerApiStatusTool(server);
  registerCreateProjectTool(server, fs);
  registerListProjectsTool(server, fs);
  registerGetDefaultProjectTool(server, fs);
  registerUploadFileTool(server, fs);
  registerAssetManifestTool(server, fs);
  registerDeleteAssetTool(server, fs);
  registerRenameAssetTool(server, fs);
  registerDuplicateAssetTool(server, fs);
  registerExportAssetTool(server, fs);
}
