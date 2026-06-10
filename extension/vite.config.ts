import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

const extensionDir = import.meta.dirname;
const repoDir = path.resolve(extensionDir, "..");
const outDir = path.resolve(repoDir, "dist-extension");
const iconsDir = path.resolve(extensionDir, "icons");

function staticExtensionFiles(): Plugin {
  return {
    name: "static-extension-files",
    writeBundle() {
      mkdirSync(outDir, { recursive: true });
      copyFileSync(path.resolve(extensionDir, "manifest.json"), path.resolve(outDir, "manifest.json"));
      mkdirSync(path.resolve(outDir, "icons"), { recursive: true });
      for (const icon of readdirSync(iconsDir)) {
        copyFileSync(path.resolve(iconsDir, icon), path.resolve(outDir, "icons", icon));
      }
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
      input: {
        background: path.resolve(extensionDir, "src/background.ts"),
        "x-post-content": path.resolve(extensionDir, "src/x-post-content.ts"),
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
