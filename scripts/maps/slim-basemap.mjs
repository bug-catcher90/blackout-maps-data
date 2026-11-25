#!/usr/bin/env node
// Usage: node slim-basemap.mjs <in.pmtiles> <out.pmtiles> [name]
// Keeps only what the app styles draw (blackout-maps website/maps/style.js and
// android/.../MapStyle.kt): their layers, the four properties they read, and
// the features their filters and zoom ranges select. Points of interest
// (the app has its own) and name translations are dropped.
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, rmSync, statSync } from "node:fs"
import { pipeline } from "node:stream/promises"
import { gunzipSync, gzipSync } from "node:zlib"
import { createWriter, openArchive } from "./lib/pmtiles.mjs"
import { slimTile } from "./lib/mvt-slim.mjs"

export const KEEP_LAYERS = new Set(["earth", "water", "landuse", "landcover", "roads", "buildings", "places", "boundaries"])
export const KEEP_KEYS = new Set(["kind", "kind_detail", "name", "ref"])

// Natural cover (forest, farmland, grass, scrub) is left out: it is about half
// of a country's tiles, and the landcover layer still tints it below z10.
export const LANDUSE_KINDS = new Set([
  "park", "garden", "playground", "recreation_ground", "golf_course", "nature_reserve", "national_park",
  "cemetery", "hospital", "school", "university", "college", "industrial", "railway", "military", "beach", "sand",
])
const ROAD_MIN_ZOOM = { highway: 6, major_road: 7, rail: 8, minor_road: 12, path: 14, ferry: 6 }
const PLACE_DETAILS = new Set(["hamlet", "locality", "farm", "isolated_dwelling", "village", "town", "city"])

// Style minzooms these limits mirror: landuse 10, buildings 14.
export function keepFeature(z, layer, { kind, kind_detail }) {
  if (layer === "landuse") return z >= 10 && LANDUSE_KINDS.has(kind)
  if (layer === "landcover") return z < 10
  if (layer === "buildings") return z >= 14
  if (layer === "roads") return z >= (ROAD_MIN_ZOOM[kind] ?? 99)
  if (layer === "boundaries") return kind === "country"
  if (layer === "places") return kind === "neighbourhood" || PLACE_DETAILS.has(kind_detail)
  return true
}

function zoomOf(tileId) {
  let z = 0
  let first = 0
  while (first + 4 ** z <= tileId) {
    first += 4 ** z
    z += 1
  }
  return z
}

const [input, output, name] = process.argv.slice(2)
if (!input || !output) {
  console.error("usage: slim-basemap.mjs <in.pmtiles> <out.pmtiles> [name]")
  process.exit(2)
}

const archive = openArchive(input)
const { header } = archive
if (header.tileType !== 1) throw new Error("expected vector tiles")
const tmp = `${output}.data`
const writer = createWriter(output, tmp)
let count = 0
let before = 0
let after = 0
for (const entry of archive.entries()) {
  const raw = archive.tileData(entry)
  const tile = header.tileCompression === 2 ? gunzipSync(raw) : raw
  const z = zoomOf(entry.tileId)
  const slim = slimTile(tile, (layer) => KEEP_LAYERS.has(layer), (_layer, key) => KEEP_KEYS.has(key), (layer, props) => keepFeature(z, layer, props))
  const bytes = header.tileCompression === 2 ? gzipSync(slim, { level: 9 }) : slim
  const hash = createHash("sha1").update(bytes).digest("base64")
  for (let i = 0; i < entry.runLength; i += 1) writer.add(entry.tileId + i, bytes, hash)
  before += raw.length
  after += bytes.length
  count += 1
  if (count % 20000 === 0) console.error(`${count} tiles, ${(before / 1e6).toFixed(0)} MB -> ${(after / 1e6).toFixed(0)} MB`)
}
const meta = archive.metadata()
archive.close()
meta.name = name || meta.name
meta.attribution = '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> · <a href="https://protomaps.com">Protomaps</a>'
meta.vector_layers = (meta.vector_layers || []).filter((layer) => KEEP_LAYERS.has(layer.id)).map((layer) => ({
  ...layer,
  fields: Object.fromEntries(Object.entries(layer.fields || {}).filter(([key]) => KEEP_KEYS.has(key))),
}))
const result = writer.finish(header, meta)
const out = createWriteStream(output)
out.write(result.prefix)
await pipeline(createReadStream(tmp), out)
rmSync(tmp)
console.error(`${output}: ${result.addressed} tiles, ${result.contents} unique, ${(statSync(output).size / 1e6).toFixed(1)} MB`)
