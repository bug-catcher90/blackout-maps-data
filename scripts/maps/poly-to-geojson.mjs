#!/usr/bin/env node
// Usage: node poly-to-geojson.mjs <in.poly> <out.geojson>
// Converts an Osmosis polygon file (https://wiki.openstreetmap.org/wiki/Osmosis/Polygon_Filter_File_Format),
// as published by Geofabrik, to a GeoJSON MultiPolygon for `pmtiles extract --region`.
import { readFileSync, writeFileSync } from "node:fs"

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error("usage: poly-to-geojson.mjs <in.poly> <out.geojson>")
  process.exit(2)
}
const rows = readFileSync(input, "utf8").split(/\r?\n/).map((line) => line.trim())
const polygons = []
let ring = null
let hole = false
for (const row of rows.slice(1)) {
  if (!row) continue
  if (ring === null) {
    if (row === "END") break
    hole = row.startsWith("!")
    ring = []
    continue
  }
  if (row === "END") {
    if (ring.length >= 3) {
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0])
      if (hole && polygons.length) polygons[polygons.length - 1].push(ring)
      else if (!hole) polygons.push([ring])
    }
    ring = null
    continue
  }
  const [lon, lat] = row.split(/\s+/).map(Number)
  if (Number.isFinite(lon) && Number.isFinite(lat)) ring.push([lon, lat])
}
if (!polygons.length) throw new Error(`${input}: no polygons`)
writeFileSync(output, JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: polygons } }] }))
