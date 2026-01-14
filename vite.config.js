import { defineConfig } from 'vite'

const backendPort = process.env.PORT || 3000;

export default defineConfig({
  server: {
    host: '0.0.0.0', // Listen on all interfaces for Docker
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true
      },
      '/ws': {
        target: `ws://localhost:${backendPort}`,
        ws: true
      }
    },
    hmr: {
      clientPort: 5173
    },
    allowedHosts: [
      'betterhsp.example.com'
    ]
  }
})
