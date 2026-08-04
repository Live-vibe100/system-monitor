// One-shot script: generates resources/tray.ico and resources/icon.ico.
// Zero external deps — uses Node's zlib + a hand-rolled PNG/ICO packer.
// Run once, then leave alone. Delete or regenerate if you want a new look.

import zlib from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(__dirname, '../resources')
mkdirSync(outDir, { recursive: true })

// --- CRC32 (needed for PNG chunks) ---
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff]
  return (c ^ 0xffffffff) >>> 0
}
function u32be(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = crc32(Buffer.concat([typeBuf, data]))
  return Buffer.concat([u32be(data.length), typeBuf, data, u32be(crc)])
}

// --- PNG generator: rounded blue square with a bar-chart glyph ---
function makePng(size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const bg = [37, 99, 235] // blue-600
  const fg = [255, 255, 255]

  const rowBytes = size * 4
  const raw = Buffer.alloc((rowBytes + 1) * size)
  const radius = Math.max(1, Math.floor(size * 0.18))

  // Bar-chart glyph geometry
  const chartPad = size * 0.22
  const chartBottom = size * 0.78
  const chartLeft = size * 0.22
  const chartRight = size * 0.78
  const barW = (chartRight - chartLeft) / 5 // 3 bars + 2 gaps in ratio
  const heights = [0.42, 0.72, 0.55]

  for (let y = 0; y < size; y++) {
    raw[y * (rowBytes + 1)] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const off = y * (rowBytes + 1) + 1 + x * 4

      // Rounded corner mask
      let inShape = true
      const cornerX = Math.min(x, size - 1 - x)
      const cornerY = Math.min(y, size - 1 - y)
      if (cornerX < radius && cornerY < radius) {
        const dx = radius - cornerX - 0.5
        const dy = radius - cornerY - 0.5
        inShape = dx * dx + dy * dy <= radius * radius
      }
      if (!inShape) {
        raw[off + 3] = 0
        continue
      }

      // Default: background blue
      let r = bg[0],
        g = bg[1],
        b = bg[2]

      // Draw white bars if inside chart area
      if (size >= 16 && y >= chartPad && y <= chartBottom) {
        for (let i = 0; i < 3; i++) {
          const bx = chartLeft + i * barW * (5 / 3)
          const barTop = chartBottom - (chartBottom - chartPad) * heights[i]
          if (x >= bx && x < bx + barW && y >= barTop) {
            r = fg[0]
            g = fg[1]
            b = fg[2]
            break
          }
        }
      }

      raw[off] = r
      raw[off + 1] = g
      raw[off + 2] = b
      raw[off + 3] = 255
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// --- ICO packer (PNG-in-ICO format, Vista+) ---
function makeIco(pngs) {
  const count = pngs.length
  const dirSize = 6 + count * 16
  let dataOffset = dirSize

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = 1 (ico)
  header.writeUInt16LE(count, 4)

  const entries = []
  for (const png of pngs) {
    const w = png.readUInt32BE(16)
    const h = png.readUInt32BE(20)
    const entry = Buffer.alloc(16)
    entry[0] = w >= 256 ? 0 : w
    entry[1] = h >= 256 ? 0 : h
    entry[2] = 0 // colors
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // planes
    entry.writeUInt16LE(32, 6) // bpp
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(dataOffset, 12)
    entries.push(entry)
    dataOffset += png.length
  }

  return Buffer.concat([header, ...entries, ...pngs])
}

const traySizes = [16, 24, 32, 48]
const iconSizes = [16, 24, 32, 48, 64, 128, 256]

const trayPngs = traySizes.map(makePng)
const iconPngs = iconSizes.map(makePng)

writeFileSync(resolve(outDir, 'tray.ico'), makeIco(trayPngs))
writeFileSync(resolve(outDir, 'icon.ico'), makeIco(iconPngs))

console.log(`Wrote ${resolve(outDir, 'tray.ico')} (${traySizes.join('/')} px)`)
console.log(`Wrote ${resolve(outDir, 'icon.ico')} (${iconSizes.join('/')} px)`)
