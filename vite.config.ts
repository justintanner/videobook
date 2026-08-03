import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const serverTarget = process.env.VIDEOBOOK_SERVER_URL ?? 'http://127.0.0.1:3001'

function clientManualChunk(id: string): string | undefined {
  if (!id.includes('/node_modules/')) return undefined
  if (id.includes('/@modelcontextprotocol/') || id.includes('/zod/')) {
    return 'vendor-mcp'
  }
  if (
    id.includes('/@xyflow/')
    || id.includes('/d3-')
    || id.includes('/zustand/')
    || id.includes('/use-sync-external-store/')
  ) {
    return 'vendor-flow'
  }
  if (id.includes('/@remotion/') || id.includes('/remotion/')) {
    return 'vendor-remotion'
  }
  if (
    id.includes('/react/')
    || id.includes('/react-dom/')
    || id.includes('/scheduler/')
  ) {
    return 'vendor-react'
  }
  return 'vendor'
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: ['babel-plugin-react-compiler'],
      },
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: clientManualChunk,
      },
    },
  },
  server: {
    proxy: {
      '/mcp': {
        target: serverTarget,
        changeOrigin: true,
      },
      '/files': {
        target: serverTarget,
        changeOrigin: true,
      },
      '/archive-files': {
        target: serverTarget,
        changeOrigin: true,
      },
      '/api': {
        target: serverTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      '/mcp': {
        target: serverTarget,
        changeOrigin: true,
      },
      '/files': {
        target: serverTarget,
        changeOrigin: true,
      },
      '/archive-files': {
        target: serverTarget,
        changeOrigin: true,
      },
      '/api': {
        target: serverTarget,
        changeOrigin: true,
      },
      '/healthz': {
        target: serverTarget,
        changeOrigin: true,
      },
    },
  },
})
