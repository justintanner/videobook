import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readdirSync, copyFileSync, mkdirSync, statSync, createReadStream } from 'node:fs'
import path from 'path'

const MEDIAPIPE_WASM_URL_PREFIX = '/mediapipe-wasm/'

function mediapipeWasm(): Plugin {
  const wasmDir = path.resolve(
    import.meta.dirname,
    'node_modules/@mediapipe/tasks-vision/wasm',
  )
  return {
    name: 'mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(MEDIAPIPE_WASM_URL_PREFIX)) return next()
        const name = req.url.slice(MEDIAPIPE_WASM_URL_PREFIX.length).split('?')[0]
        const full = path.join(wasmDir, name)
        if (!full.startsWith(wasmDir + path.sep)) return next()
        try {
          statSync(full)
        } catch {
          return next()
        }
        res.setHeader(
          'Content-Type',
          name.endsWith('.wasm') ? 'application/wasm' : 'application/javascript',
        )
        createReadStream(full).pipe(res)
      })
    },
    writeBundle(options) {
      const outDir = path.resolve(options.dir ?? 'dist', 'mediapipe-wasm')
      mkdirSync(outDir, { recursive: true })
      for (const name of readdirSync(wasmDir)) {
        if (name.startsWith('.')) continue
        copyFileSync(path.join(wasmDir, name), path.join(outDir, name))
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), mediapipeWasm()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    proxy: {
      '/mcp': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/files': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/archive-files': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
})
