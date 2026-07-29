import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const serverTarget = process.env.VIDEOBOOK_SERVER_URL ?? 'http://127.0.0.1:3001'

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
