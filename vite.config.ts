import { defineConfig } from 'vite'

export default defineConfig({
  // allowedHosts lets the phone load the dev server via the host's Tailscale
  // MagicDNS name — Vite otherwise 403s a Host header it doesn't recognise.
  // Scoped to the tailnet (`.ts.net`); the packed app doesn't use the dev server.
  server: { host: true, port: 5175, allowedHosts: ['.ts.net'] },
  build: { target: 'esnext' },
})
