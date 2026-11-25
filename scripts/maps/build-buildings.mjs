#!/usr/bin/env node
// Usage: node build-buildings.mjs <buildings.geojsonseq> <buildings.bin>
// Input: `osmium export -f geojsonseq` of building areas. Output: the BLD1
// outline book read by openBuildingBook() in scripts/readers/buildings.js.
// Format: SPEC.md.
import { writeFileSync } from "node:fs"
import { GrowableInt32, lines } from "./lib/opl.mjs"

const UNIT = 10
const BASE_STEP = 5000
const MAX_CELLS = 4_000_000

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error("usage: build-buildings.mjs <buildings.geojsonseq> <buildings.bin>")
  process.exit(2)
}

const originLat = new GrowableInt32()
const originLon = new GrowableInt32()
const boxes = new GrowableInt32(1 << 22)
const geom = new GrowableInt32(1 << 24, Uint8Array)
const geomOff = new GrowableInt32(1 << 20, Uint32Array)
const geomLen = new GrowableInt32(1 << 20, Uint16Array)

function addRing(ring) {
  let points = ring
  if (points.length > 1) {
    const [a, b] = [points[0], points[points.length - 1]]
    if (a[0] === b[0] && a[1] === b[1]) points = points.slice(0, -1)
  }
  if (points.length < 3 || points.length > 16000) return
  const lat0 = Math.round(points[0][1] * 1e6)
  const lon0 = Math.round(points[0][0] * 1e6)
  const deltas = []
  let minLat = lat0
  let maxLat = lat0
  let minLon = lon0
  let maxLon = lon0
  for (let i = 1; i < points.length; i += 1) {
    const lat = Math.round(points[i][1] * 1e6)
    const lon = Math.round(points[i][0] * 1e6)
    const dLat = Math.round((lat - lat0) / UNIT)
    const dLon = Math.round((lon - lon0) / UNIT)
    if (dLat < -32768 || dLat > 32767 || dLon < -32768 || dLon > 32767) return
    deltas.push(dLat, dLon)
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
  }
  const n = points.length
  geomOff.push(geom.length)
  geomLen.push(2 + deltas.length * 2)
  geom.push(n & 255)
  geom.push((n >> 8) & 255)
  for (const value of deltas) {
    geom.push(value & 255)
    geom.push((value >> 8) & 255)
  }
  originLat.push(lat0)
  originLon.push(lon0)
  boxes.push(minLat)
  boxes.push(minLon)
  boxes.push(maxLat)
  boxes.push(maxLon)
}

for await (const line of lines(input)) {
  const text = line.charCodeAt(0) === 0x1e ? line.slice(1) : line
  if (!text) continue
  let feature
  try {
    feature = JSON.parse(text)
  } catch {
    continue
  }
  const geometry = feature.geometry
  if (!geometry) continue
  if (geometry.type === "Polygon") addRing(geometry.coordinates[0] || [])
  else if (geometry.type === "MultiPolygon") for (const polygon of geometry.coordinates) addRing(polygon[0] || [])
}

const count = originLat.length
if (!count) throw new Error("no buildings")
const box = boxes.view()
let minLat = Infinity
let minLon = Infinity
let maxLat = -Infinity
let maxLon = -Infinity
for (let i = 0; i < count; i += 1) {
  minLat = Math.min(minLat, box[i * 4])
  minLon = Math.min(minLon, box[i * 4 + 1])
  maxLat = Math.max(maxLat, box[i * 4 + 2])
  maxLon = Math.max(maxLon, box[i * 4 + 3])
}
let step = BASE_STEP
let lat0
let lon0
let latN
let lonN
for (;;) {
  lat0 = Math.floor(minLat / step) * step
  lon0 = Math.floor(minLon / step) * step
  latN = Math.floor((maxLat - lat0) / step) + 1
  lonN = Math.floor((maxLon - lon0) / step) + 1
  if (latN * lonN <= MAX_CELLS) break
  step += BASE_STEP
}
const cellCount = latN * lonN
const cellHead = new Uint32Array(cellCount + 1)
const range = (i) => [
  Math.floor((box[i * 4] - lat0) / step),
  Math.floor((box[i * 4 + 1] - lon0) / step),
  Math.floor((box[i * 4 + 2] - lat0) / step),
  Math.floor((box[i * 4 + 3] - lon0) / step),
]
for (let i = 0; i < count; i += 1) {
  const [y0, x0, y1, x1] = range(i)
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) cellHead[y * lonN + x + 1] += 1
}
for (let i = 1; i <= cellCount; i += 1) cellHead[i] += cellHead[i - 1]
const cellIds = new Uint32Array(cellHead[cellCount])
const fill = cellHead.slice(0, cellCount)
for (let i = 0; i < count; i += 1) {
  const [y0, x0, y1, x1] = range(i)
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) cellIds[fill[y * lonN + x]++] = i
}

const align = (value) => (value + 3) & ~3
const geomBytes = geom.length
const size = align(align(64 + count * 12 + count * 2) + geomBytes) + (cellCount + 1) * 4 + cellIds.length * 4
const out = Buffer.alloc(size)
const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
out.write("BLD1", 0, "latin1")
view.setUint32(4, 1, true)
view.setUint32(8, count, true)
view.setInt32(12, lat0, true)
view.setInt32(16, lon0, true)
view.setUint32(20, latN, true)
view.setUint32(24, lonN, true)
view.setUint32(28, step, true)
view.setUint32(32, cellCount, true)
view.setUint32(36, geomBytes, true)
view.setUint32(40, size, true)
let offset = 64
const put = (array) => {
  out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset)
  offset += array.byteLength
}
put(originLat.view())
put(originLon.view())
put(geomOff.view())
put(geomLen.view())
offset = align(offset)
put(geom.view())
offset = align(offset)
put(cellHead)
put(cellIds)
if (offset !== size) throw new Error(`size mismatch ${offset} != ${size}`)
writeFileSync(output, out)
console.error(`${output}: ${count} buildings, grid ${latN}x${lonN} step ${step}, ${(size / 1e6).toFixed(1)} MB`)
