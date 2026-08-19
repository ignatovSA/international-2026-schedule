#!/usr/bin/env node
/**
 * Minimal static file server for local development.
 *
 * A service worker will not register over file://, so the PWA has to be opened
 * over http to be testable. No dependencies — this is ~60 lines of node:http.
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const PORT = Number(process.env.PORT) || 5173
const HOST = process.env.HOST || '0.0.0.0'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    // normalize() + the prefix check below keep `../` out of the served root.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
    let filePath = join(ROOT, rel)

    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden')
      return
    }

    const info = await stat(filePath).catch(() => null)
    if (!info || info.isDirectory()) filePath = join(filePath, 'index.html')

    const body = await readFile(filePath)
    const ext = extname(filePath)

    // Never cache during development — especially the SW and the schedule.
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
      'Service-Worker-Allowed': '/',
    })
    res.end(body)
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`Server error: ${err.message}`)
    }
  }
})

server.listen(PORT, HOST, () => {
  console.log(`\n  TI 2026 schedule running at:\n`)
  console.log(`    http://localhost:${PORT}`)
  console.log(`\n  Open that address on your phone using this machine's LAN IP`)
  console.log(`  to install it as an app.\n`)
})
