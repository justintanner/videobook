import { Console } from "node:console";

export function redirectConsoleToStderr(): void {
  Object.defineProperty(globalThis, "console", {
    value: new Console({ stdout: process.stderr, stderr: process.stderr }),
    writable: true,
    configurable: true,
  });
}
