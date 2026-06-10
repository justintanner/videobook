import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

const extensionDir = import.meta.dirname;
const repoDir = path.resolve(extensionDir, "..");
const outDir = path.resolve(repoDir, "dist-extension");

function staticExtensionFiles(): Plugin {
  return {
    name: "static-extension-files",
    writeBundle() {
      mkdirSync(outDir, { recursive: true });
      copyFileSync(path.resolve(extensionDir, "manifest.json"), path.resolve(outDir, "manifest.json"));
      copyFileSync(path.resolve(repoDir, "vc-logo.png"), path.resolve(outDir, "vc-logo.png"));
    },
  };
}

export default defineConfig({
  root: extensionDir,
  publicDir: false,
  plugins: [staticExtensionFiles()],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: path.resolve(extensionDir, "src/background.ts"),
      output: {
        entryFileNames: "background.js",
        inlineDynamicImports: true,
      },
    },
  },
});
