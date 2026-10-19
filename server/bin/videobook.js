#!/usr/bin/env node
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  process.stderr.write(`videobook needs Node.js 22 or newer; this is ${process.version}.\nInstall Node.js 22+ from https://nodejs.org or your version manager, then run videobook again.\n`);
  process.exit(1);
}
await import(new URL("../dist/cli/entry.js", import.meta.url).href);
