#!/usr/bin/env node
// Pack guard: the tracked app.json is packed verbatim, and the artifact
// filename is stamped from package.json — refuse to pack if the two versions
// have drifted (the rule is to bump both together).
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const app = JSON.parse(readFileSync('app.json', 'utf8'))
if (pkg.version !== app.version) {
  console.error(`pack: version drift — package.json ${pkg.version} vs app.json ${app.version}; bump both.`)
  process.exit(1)
}
