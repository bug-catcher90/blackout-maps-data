// Streams OSM OPL lines (https://osmcode.org/opl-file-format/), as written by
// `osmium ... -f opl,add_metadata=false`, and parses ways with locations.
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

export async function* lines(path) {
  const input = path === "-" ? process.stdin : createReadStream(path, { highWaterMark: 1 << 22 })
  const reader = createInterface({ input, crlfDelay: Infinity })
  for await (const line of reader) if (line) yield line
}

function unescape(text) {
  if (!text.includes("%")) return text
  return text.replace(/%([0-9a-fA-F]+)%/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
}

export function parseTags(field) {
  const tags = {}
  if (!field) return tags
  for (const pair of field.split(",")) {
    if (!pair) continue
    const at = pair.indexOf("=")
    if (at < 0) continue
    tags[unescape(pair.slice(0, at))] = unescape(pair.slice(at + 1))
  }
  return tags
}

// Returns { id, tags, refs: number[], lat: number[], lon: number[] } for a way
// line with locations (`n12x-9.1y38.7`), or null for any other line.
export function parseWay(line) {
  if (line[0] !== "w") return null
  let tagField = ""
  let nodeField = ""
  const id = Number(line.slice(1, line.indexOf(" ")))
  for (const part of line.split(" ")) {
    if (part[0] === "T") tagField = part.slice(1)
    else if (part[0] === "N") nodeField = part.slice(1)
  }
  const refs = []
  const lat = []
  const lon = []
  if (nodeField) {
    for (const node of nodeField.split(",")) {
      const x = node.indexOf("x")
      const y = node.indexOf("y")
      if (x < 0 || y < 0) continue
      const lonText = node.slice(x + 1, y)
      const latText = node.slice(y + 1)
      if (!lonText || !latText) continue
      refs.push(Number(node.slice(1, x)))
      lon.push(Number(lonText))
      lat.push(Number(latText))
    }
  }
  return { id, tags: parseTags(tagField), refs, lat, lon }
}

export function metersBetween(lat1, lon1, lat2, lon2) {
  const radius = 6371000
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dp = p2 - p1
  const dl = ((lon2 - lon1) * Math.PI) / 180
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)))
}

export class GrowableInt32 {
  constructor(initial = 1 << 20, Type = Int32Array) {
    this.Type = Type
    this.data = new Type(initial)
    this.length = 0
  }
  push(value) {
    if (this.length === this.data.length) {
      const next = new this.Type(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = value
  }
  view() {
    return this.data.subarray(0, this.length)
  }
}
