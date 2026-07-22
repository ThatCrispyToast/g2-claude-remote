import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  // allowedHosts lets the phone load the dev server via the host's Tailscale
  // MagicDNS name — Vite otherwise 403s a Host header it doesn't recognise.
  // Scoped to the tailnet (`.ts.net`); the packed app doesn't use the dev server.
  server: { host: true, port: 5175, allowedHosts: ['.ts.net'] },
  build: { target: 'esnext' },
  // `.env.local` is a dev-server convenience only. A build resolves NO env vars
  // (the prefix below matches nothing), so `config.ts` falls back to runtime
  // Settings + defaults and a pack can never carry personal keys or hosts —
  // every pack is a distribution pack, whatever is on disk.
  envPrefix: command === 'build' ? 'NEVER_BAKE_' : 'VITE_',
}))
