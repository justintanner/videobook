import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const serverTarget = process.env.VIDEOBOOK_SERVER_URL ?? 'http://127.0.0.1:3001'

function clientManualChunk(id: string): string | undefined {
  if (id.includes('/src/components/videobook/NotebookCellInspector')) {
    return 'inspector'
  }
  if (id.includes('/src/components/videobook/MomentSearch')) {
    return 'search-ui'
  }
  if (id.includes('/src/components/videobook/NotebookMediaFullscreen')) {
    return 'fullscreen'
  }
  if (id.includes('/src/components/videobook/JobsScreen')) {
    return 'jobs-ui'
  }
  if (id.includes('/src/components/videobook/MusicVideoEditor')) {
    return 'music-video'
  }
  if (id.includes('/src/components/videobook/AliveCaptions') || id.includes('/src/remotion/AliveCaptionsPreview')) {
    return 'alive-captions'
  }
  if (id.includes('/src/components/')) {
    return 'ui'
  }
  if (id.includes('/src/videobook/')) {
    return 'videobook'
  }
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
  if (id.includes('/lucide-react/')) {
    return 'vendor-icons'
  }
  return 'vendor'
}

// https://vite.dev/config/
export default defineConfig({
  cacheDir: process.env.VIDEOBOOK_VITE_CACHE_DIR || 'node_modules/.vite',
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
    hmr: process.env.VIDEOBOOK_VITE_HMR === '0' ? false : undefined,
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
        ws: true,
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
        ws: true,
      },
      '/healthz': {
        target: serverTarget,
        changeOrigin: true,
      },
    },
  },
})
