import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
//
// PI_LAN=1 exposes the dev server on the local network so a phone or a second
// machine can open the dashboard. Off by default: whoever can reach this port
// can talk to your agents through it.
const lan = Boolean(process.env.PI_LAN)
const bridgePort = process.env.BRIDGE_PORT ?? '8787'

export default defineConfig({
  plugins: [react()],
  server: {
    host: lan ? true : '127.0.0.1',
    // The extension opens a fixed port. Without strictPort a busy 5173 would
    // silently become 5174 and the /dashboard link would point at nothing.
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${bridgePort}`,
    },
  },
})
