#!/usr/bin/env node
/**
 * Generates the PWA icons from an inline SVG.
 *
 * The generated PNGs are committed, so you only need to run this if you change
 * the artwork. Requires `rsvg-convert` (brew install librsvg).
 *
 * The mark is drawn with plain geometry rather than text so it renders
 * identically everywhere, without depending on installed fonts.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ICONS = resolve(ROOT, 'public/icons')

/**
 * @param {object} options
 * @param {boolean} options.maskable  Shrink the mark so Android's mask can't clip it.
 * @param {boolean} options.rounded   Rounded corners (skip for maskable — the OS masks it).
 */
function svg({ maskable = false, rounded = true } = {}) {
  const S = 512
  // Maskable icons must keep their content inside the middle 80% "safe zone".
  const scale = maskable ? 0.62 : 0.82
  const shift = (S - S * scale) / 2

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#171a21"/>
      <stop offset="1" stop-color="#08090c"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.28" r="0.72">
      <stop offset="0" stop-color="#e23a3a" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#e23a3a" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffd97a"/>
      <stop offset="0.5" stop-color="#f0b429"/>
      <stop offset="1" stop-color="#b47611"/>
    </linearGradient>
  </defs>

  <rect width="${S}" height="${S}" rx="${rounded ? 112 : 0}" fill="url(#bg)"/>
  <rect width="${S}" height="${S}" rx="${rounded ? 112 : 0}" fill="url(#glow)"/>

  <g transform="translate(${shift} ${shift}) scale(${scale})">
    <!-- Aegis-like shield -->
    <path d="M256 40 L432 104 C432 268 360 396 256 472 C152 396 80 268 80 104 Z"
          fill="url(#gold)"/>
    <path d="M256 74 L404 128 C404 268 342 378 256 444 C170 378 108 268 108 128 Z"
          fill="#0b0d11"/>

    <!-- "TI", built from rectangles so no font is required.
         Nudged right so the T+I pair is optically centred on the shield. -->
    <g fill="url(#gold)" transform="translate(16 0)">
      <rect x="146" y="168" width="132" height="34" rx="8"/>
      <rect x="195" y="168" width="34" height="150" rx="8"/>
      <rect x="300" y="168" width="34" height="150" rx="8"/>
    </g>

    <!-- "26" underline accent -->
    <rect x="176" y="352" width="160" height="16" rx="8" fill="#e23a3a"/>
  </g>
</svg>`
}

async function convert(source, outFile, size) {
  const tmp = resolve(ICONS, '.tmp.svg')
  await writeFile(tmp, source)
  try {
    await run('rsvg-convert', ['-w', String(size), '-h', String(size), tmp, '-o', outFile])
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('rsvg-convert not found. Install it with: brew install librsvg')
    }
    throw err
  }
  console.log(`  ${outFile.replace(`${ROOT}/`, '')} (${size}×${size})`)
}

async function main() {
  await mkdir(ICONS, { recursive: true })
  console.log('Generating icons…')

  const standard = svg()
  await writeFile(resolve(ICONS, 'favicon.svg'), standard)
  console.log('  public/icons/favicon.svg')

  await convert(standard, resolve(ICONS, 'icon-192.png'), 192)
  await convert(standard, resolve(ICONS, 'icon-512.png'), 512)
  // iOS does not apply a mask, so it gets the square (already rounded) artwork.
  await convert(svg({ rounded: false }), resolve(ICONS, 'apple-touch-icon.png'), 180)
  await convert(svg({ maskable: true, rounded: false }), resolve(ICONS, 'icon-maskable-512.png'), 512)

  const { unlink } = await import('node:fs/promises')
  await unlink(resolve(ICONS, '.tmp.svg')).catch(() => {})
  console.log('Done.')
}

main().catch((err) => {
  console.error(`Icon generation failed: ${err.message}`)
  process.exitCode = 1
})
