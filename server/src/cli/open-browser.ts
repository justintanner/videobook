import { spawn } from "node:child_process";

function browserCommand(url: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const { command, args } = browserCommand(url, platform);
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
