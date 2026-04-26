import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { gatewayProxy } from './vite-plugins/gatewayProxy'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    gatewayProxy({
      // downstreamPort defaults to 4242
      // upstreamUrl defaults to ws://127.0.0.1:18789
      // configPath defaults to ~/.openclaw/openclaw.json
    }),
  ],
  server: {
    host: '127.0.0.1',
  },
})
