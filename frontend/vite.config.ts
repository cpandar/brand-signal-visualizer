import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../nodes/signal_visualizer/static',
    emptyOutDir: true,
  },
  server: {
    // Proxy WebSocket to the Python node during development
    proxy: {
      '/ws': {
        target: 'ws://localhost:8765',
        ws: true,
      },
      '/manifest': 'http://localhost:8765',
    },
  },
})
