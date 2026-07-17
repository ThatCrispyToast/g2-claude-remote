#!/usr/bin/env node
// Generate app.local.json — the manifest actually packed into the .ehpk.
//
// The tracked app.json stays generic (its network whitelist carries a "*"
// wildcard). Personal values live in .env.local; this script folds them in at
// pack time so a self-built artifact also whitelists your bridge host
// explicitly — belt-and-braces in case the installed Even app build doesn't
// honor the wildcard entry. It also stamps package.json's version into the
// manifest, so the two can never drift inside an artifact.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** KEY=VALUE pairs from a dotenv-style file (comments and quotes handled). */
function parseEnv(path) {
  const out = {}
  for (let line of readFileSync(path, 'utf8').split('\n')) {
    line = line.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const [key, ...rest] = line.split('=')
    out[key.trim()] = rest.join('=').split(' #')[0].trim().replace(/^['"]|['"]$/g, '')
  }
  return out
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const app = JSON.parse(readFileSync('app.json', 'utf8'))
app.version = pkg.version

const env = existsSync('.env.local') ? parseEnv('.env.local') : {}
const extra = []
if (env.VITE_BRIDGE_URL) {
  try {
    const u = new URL(env.VITE_BRIDGE_URL)
    extra.push(`http://${u.host}`, `https://${u.host}`)
  } catch {
    console.warn(`prepack: VITE_BRIDGE_URL is not a valid URL, skipping: ${env.VITE_BRIDGE_URL}`)
  }
}
for (const e of (env.VITE_NET_WHITELIST_EXTRA ?? '').split(',')) {
  if (e.trim()) extra.push(e.trim())
}

const net = app.permissions.find((p) => p.name === 'network')
if (net) net.whitelist = [...new Set([...(net.whitelist ?? []), ...extra])]

writeFileSync('app.local.json', JSON.stringify(app, null, 2) + '\n')
console.log(
  `prepack: app.local.json ready (v${app.version}` +
    (extra.length ? `, added to whitelist: ${extra.join(', ')})` : ')'),
)
