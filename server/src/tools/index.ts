import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { registerApiStatusTool } from "./api-status.js";
import { registerHelloTool } from "./hello.js";
import { registerCreateProjectTool } from "./create-project.js";
import { registerListProjectsTool } from "./list-projects.js";
import { registerGetDefaultProjectTool } from "./get-default-project.js";
import { registerUploadFileTool } from "./upload-file.js";

export function registerAllTools(server: McpServer, fs: ClipfirstFs): void {
  registerHelloTool(server);
  registerApiStatusTool(server);
  registerCreateProjectTool(server, fs);
  registerListProjectsTool(server, fs);
  registerGetDefaultProjectTool(server, fs);
  registerUploadFileTool(server, fs);
}
