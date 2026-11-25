// Checks country packages against SPEC.md.
//
//   node scripts/validate-catalog.mjs                 every catalog/*.json, parts in catalog/<id>/
//   node scripts/validate-catalog.mjs catalog/x.json  only those entries
//   --shallow       check the JSON only, without opening the data files
//   --remote        also check that every part URL answers with its size and CORS
//   --download      download parts that are not in the repository and check them in full
//
// Exits 1 when any package is missing a required layer or file.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { openPlaceBook, CATEGORIES } from "./readers/places.js"
import { openWaterBook } from "./readers/water.js"
import { openAddressBook } from "./readers/addresses.js"
import { openRoadGraph } from "./readers/route.js"
import { openBuildingBook, buildingsInView } from "./readers/buildings.js"
import { openArchive } from "./maps/lib/pmtiles.mjs"
import { layerName } from "./maps/lib/mvt-slim.mjs"
import { buildIndex, INDEX_NAME } from "./make-index.mjs"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const REPO_RAW = "https://raw.githubusercontent.com/bug-catcher90/blackout-maps-data/main/"

export const REQUIRED = [
  { key: "places", file: "places.bin", gzip: true, label: "lugares" },
  { key: "water", file: "water.bin", gzip: true, label: "água" },
  { key: "addresses", file: "addresses.bin", gzip: true, label: "moradas" },
  { key: "geo", file: "geo.json", gzip: true, label: "geo" },
  { key: "roads", file: "roads.bin", gzip: true, label: "estradas" },
  { key: "buildings", file: "buildings.bin", gzip: true, label: "edifícios" },
  { key: "map", file: "map.pmtiles", gzip: false, label: "mapa" },
]
export const MAP_LAYERS = ["earth", "water", "landuse", "roads", "buildings", "places"]
// GitHub warns above 50 MB per file and rejects above 100 MB.
export const PART_BYTES = 45_000_000
// Both apps hold the road graph and the buildings in memory at once.
export const MEMORY_BYTES = 450_000_000
const LEGACY_KEYS = new Set(["places", "water", "addresses", "geo", "roads"])

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  if (at < 0) return false
  args.splice(at, 1)
  return true
}
const shallow = flag("--shallow")
const remote = flag("--remote")
const download = flag("--download")

const entries = (args.length
  ? args.map((path) => resolve(path))
  : readdirSync(join(repo, "catalog"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(repo, "catalog", name))
).filter((path) => basename(path) !== INDEX_NAME)

let failures = 0

function rangeOverlaps(a, b) {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

async function partBytes(spec, part, index, problems) {
  const where = `${spec.key} part ${index}`
  if (part.url.startsWith(REPO_RAW)) {
    const path = join(repo, decodeURIComponent(part.url.slice(REPO_RAW.length)))
    if (existsSync(path)) return readFileSync(path)
    if (!download) {
      problems.push(`${where}: ${part.url.slice(REPO_RAW.length)} is not in the repository`)
      return null
    }
  } else if (!download) return null
  const response = await fetch(part.url)
  if (!response.ok) {
    problems.push(`${where}: ${part.url} answered ${response.status}`)
    return null
  }
  return Buffer.from(await response.arrayBuffer())
}

// Joins the parts after checking each one; null when any part is unavailable.
async function packedBytes(spec, problems) {
  const chunks = []
  for (const [index, part] of spec.parts.entries()) {
    const bytes = await partBytes(spec, part, index, problems)
    if (!bytes) return null
    if (bytes.length !== part.bytes) problems.push(`${spec.key} part ${index}: ${bytes.length} bytes, catalog says ${part.bytes}`)
    else if (sha256(bytes) !== part.sha256) problems.push(`${spec.key} part ${index}: SHA-256 does not match`)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

async function checkUrl(spec, part, index, problems) {
  const where = `${spec.key} part ${index}`
  try {
    const response = await fetch(part.url, { method: "HEAD", redirect: "follow" })
    if (!response.ok) problems.push(`${where}: ${part.url} answered ${response.status}`)
    else if (Number(response.headers.get("content-length")) !== part.bytes) {
      problems.push(`${where}: ${part.url} is ${response.headers.get("content-length")} bytes, catalog says ${part.bytes}`)
    }
    if (response.ok && response.headers.get("access-control-allow-origin") !== "*") {
      problems.push(`${where}: ${part.url} sends no "Access-Control-Allow-Origin: *", the web app cannot download it`)
    }
  } catch (error) {
    problems.push(`${where}: ${part.url} ${error.message}`)
  }
}

function checkMap(data, problems, facts) {
  const tmp = join(tmpdir(), `validate-${process.pid}.pmtiles`)
  writeFileSync(tmp, data)
  try {
    const archive = openArchive(tmp)
    const { header } = archive
    if (header.tileType !== 1) problems.push("map: tiles are not vector (MVT)")
    if (header.maxZoom < 14) problems.push(`map: max zoom ${header.maxZoom}, needs 14 for street detail`)
    facts.mapBounds = { west: header.minLonE7 / 1e7, south: header.minLatE7 / 1e7, east: header.maxLonE7 / 1e7, north: header.maxLatE7 / 1e7 }
    const declared = new Set((archive.metadata().vector_layers || []).map((layer) => layer.id))
    for (const layer of MAP_LAYERS) if (!declared.has(layer)) problems.push(`map: no "${layer}" layer`)
    const seen = new Set()
    const all = [...archive.entries()]
    // Low zooms come first in tile order and buildings only exist at the top zoom, so sample both ends.
    const sample = all.length > 6000 ? [...all.slice(0, 3000), ...all.slice(-3000)] : all
    for (const entry of sample) {
      if (MAP_LAYERS.every((layer) => seen.has(layer))) break
      let tile = archive.tileData(entry)
      if (header.tileCompression === 2) tile = gunzipSync(tile)
      for (let pos = 0; pos < tile.length; ) {
        let tag = 0
        let shift = 0
        let byte
        do {
          byte = tile[pos++]
          tag += (byte & 0x7f) * 2 ** shift
          shift += 7
        } while (byte >= 0x80)
        let length = 0
        shift = 0
        do {
          byte = tile[pos++]
          length += (byte & 0x7f) * 2 ** shift
          shift += 7
        } while (byte >= 0x80)
        if (tag === 26) seen.add(layerName(tile.subarray(pos, pos + length)))
        pos += length
      }
    }
    for (const layer of MAP_LAYERS) if (declared.has(layer) && !seen.has(layer)) problems.push(`map: "${layer}" is declared but no tile holds it`)
    archive.close()
  } catch (error) {
    problems.push(`map: ${error.message}`)
  } finally {
    rmSync(tmp, { force: true })
  }
}

async function checkFile(spec, packed, problems, facts) {
  const data = spec.gzip ? gunzipSync(packed) : packed
  if (data.length !== spec.bytes) problems.push(`${spec.key}: unpacks to ${data.length} bytes, catalog says ${spec.bytes}`)
  else if (sha256(data) !== spec.sha256) problems.push(`${spec.key}: SHA-256 of the unpacked file does not match`)
  if (spec.key === "map") {
    checkMap(data, problems, facts)
    return
  }
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  switch (spec.key) {
    case "places": {
      const book = openPlaceBook(buffer)
      const counts = CATEGORIES.map(() => 0)
      let west = 180
      let east = -180
      let south = 90
      let north = -90
      for (let i = 0; i < book.count; i += 1) {
        counts[book.category[i]] += 1
        const lat = book.lat[i] / 1e6
        const lon = book.lon[i] / 1e6
        west = Math.min(west, lon)
        east = Math.max(east, lon)
        south = Math.min(south, lat)
        north = Math.max(north, lat)
      }
      CATEGORIES.forEach((category, index) => {
        if (!counts[index]) problems.push(`places: no ${category.label} (category ${index})`)
      })
      facts.places = { west, east, south, north }
      facts.counts.places = book.count
      break
    }
    case "water": {
      const book = openWaterBook(buffer)
      if (!book.count) problems.push("water: no water points")
      facts.counts.water = book.count
      break
    }
    case "addresses": {
      const book = await openAddressBook(new Blob([data]))
      const doors = Math.floor((data.length - book.recordOffset) / 18)
      if (!book.streets.length || !doors) problems.push("addresses: no streets or doors")
      facts.counts.doors = doors
      break
    }
    case "geo": {
      const geo = JSON.parse(data.toString("utf8"))
      const ok = (row, size) => Array.isArray(row) && row.length >= size && typeof row[0] === "string" && Number.isFinite(row[1]) && Number.isFinite(row[2])
      if (!Array.isArray(geo.p) || !geo.p.length || !geo.p.every((row) => ok(row, 4))) problems.push("geo: p (places) is empty or malformed")
      if (!Array.isArray(geo.s) || !geo.s.length || !geo.s.every((row) => ok(row, 3))) problems.push("geo: s (streets) is empty or malformed")
      facts.counts.searchNames = (geo.p?.length || 0) + (geo.s?.length || 0)
      break
    }
    case "roads": {
      const graph = openRoadGraph(buffer)
      let walk = 0
      let car = 0
      for (let e = 0; e < graph.edgeCount; e += 1) {
        if (graph.access[e] & 1) walk += 1
        if (graph.access[e] & 4) car += 1
      }
      if (!walk) problems.push("roads: no walkable edges")
      if (!car) problems.push("roads: no drivable edges")
      facts.roads = {
        south: graph.gridLat0 / 1e7,
        west: graph.gridLon0 / 1e7,
        north: (graph.gridLat0 + graph.gridLatN * graph.gridStep) / 1e7,
        east: (graph.gridLon0 + graph.gridLonN * graph.gridStep) / 1e7,
      }
      facts.counts.roadEdges = graph.edgeCount
      break
    }
    case "buildings": {
      const book = openBuildingBook(new Uint8Array(buffer))
      if (!book.count) problems.push("buildings: no buildings")
      else {
        const lat = book.originLat[0] / 1e6
        const lon = book.originLon[0] / 1e6
        if (!buildingsInView(book, lon - 0.001, lat - 0.001, lon + 0.001, lat + 0.001).features.length) {
          problems.push("buildings: the grid does not find the first building; the header grid is wrong")
        }
      }
      const { grid } = book
      facts.buildings = { south: grid.lat0 / 1e6, west: grid.lon0 / 1e6, north: (grid.lat0 + grid.latN * grid.step) / 1e6, east: (grid.lon0 + grid.lonN * grid.step) / 1e6 }
      facts.counts.buildings = book.count
      break
    }
  }
}

for (const path of entries) {
  const problems = []
  const facts = { counts: {} }
  let pack
  try {
    pack = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    console.log(`FAIL ${basename(path)}: not JSON (${error.message})`)
    failures += 1
    continue
  }
  const id = basename(path, ".json")
  if (pack.id !== id) problems.push(`id "${pack.id}" does not match the file name`)
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) problems.push("id must be lowercase words joined by hyphens")
  if (!pack.name || typeof pack.name !== "string") problems.push("name is missing")
  if (!pack.flag || typeof pack.flag !== "string") problems.push("flag is missing")
  if (typeof pack.autoload !== "boolean") problems.push("autoload must be true or false")
  if (pack.autoload && id !== "portugal") problems.push("only portugal autoloads")
  const assets = Array.isArray(pack.assets) ? pack.assets : []
  if (!assets.length) problems.push("no assets list (see SPEC.md)")
  const byKey = new Map(assets.map((file) => [file?.key, file]))
  // Only the autoload package may leave files to the copies built into the apps.
  const builtIn = new Set(Array.isArray(pack.builtIn) ? pack.builtIn : [])
  if (builtIn.size && !pack.autoload) problems.push("builtIn is only for the autoload package, whose base files ship inside the apps")
  for (const key of builtIn) if (!["map", "roads", "buildings"].includes(key)) problems.push(`builtIn: "${key}" is not shipped in the apps`)
  for (const required of REQUIRED) {
    const spec = byKey.get(required.key)
    if (!spec) {
      if (!builtIn.has(required.key)) problems.push(`no "${required.key}" file`)
      continue
    }
    if (spec.file !== required.file) problems.push(`${required.key}: file should be "${required.file}"`)
    if (spec.gzip !== required.gzip) problems.push(`${required.key}: gzip should be ${required.gzip}`)
    if (spec.label !== required.label) problems.push(`${required.key}: label should be "${required.label}"`)
    if (!Number.isInteger(spec.bytes) || spec.bytes <= 0) problems.push(`${required.key}: bytes must be the unpacked size`)
    if (!/^[0-9a-f]{64}$/.test(spec.sha256 || "")) problems.push(`${required.key}: sha256 must be the hex SHA-256 of the unpacked file`)
    if (!Array.isArray(spec.parts) || !spec.parts.length) {
      problems.push(`${required.key}: parts is empty`)
      spec.parts = []
    }
    spec.parts.forEach((part, index) => {
      const where = `${required.key} part ${index}`
      if (typeof part?.url !== "string" || !part.url.startsWith("https://")) problems.push(`${where}: url must be https`)
      if (!Number.isInteger(part?.bytes) || part.bytes <= 0 || part.bytes > PART_BYTES) problems.push(`${where}: bytes must be 1..${PART_BYTES}`)
      if (!/^[0-9a-f]{64}$/.test(part?.sha256 || "")) problems.push(`${where}: sha256 is missing`)
    })
  }
  for (const spec of assets) if (!REQUIRED.some((row) => row.key === spec?.key)) problems.push(`unknown file key "${spec?.key}"`)
  const memory = (byKey.get("roads")?.bytes || 0) + (byKey.get("buildings")?.bytes || 0)
  if (memory > MEMORY_BYTES) problems.push(`roads + buildings unpack to ${(memory / 1e6).toFixed(0)} MB; phones hold both in memory, keep it under ${MEMORY_BYTES / 1e6} MB by splitting the area into regions`)

  // `files` is the list the 1.0 apps read: single-part copies of assets only.
  for (const legacy of assets.length && Array.isArray(pack.files) ? pack.files : []) {
    const asset = byKey.get(legacy?.key)
    if (!LEGACY_KEYS.has(legacy?.key)) problems.push(`files: "${legacy?.key}" is not read by the 1.0 apps, keep it in assets only`)
    else if (!asset || asset.parts.length !== 1 || legacy.url !== asset.parts[0].url || legacy.bytes !== asset.bytes || legacy.file !== asset.file || legacy.gzip !== asset.gzip) {
      problems.push(`files: "${legacy.key}" must copy its single-part asset (url, file, gzip, bytes)`)
    }
  }
  if (pack.files !== undefined && !Array.isArray(pack.files)) problems.push("files must be a list")

  let checked = 0
  for (const required of REQUIRED) {
    const spec = byKey.get(required.key)
    if (!spec || !spec.parts.length || !spec.parts.every((part) => typeof part?.url === "string")) continue
    if (remote) for (const [index, part] of spec.parts.entries()) await checkUrl(spec, part, index, problems)
    if (shallow) continue
    const packed = await packedBytes(spec, problems)
    if (!packed) continue
    try {
      await checkFile(spec, packed, problems, facts)
      checked += 1
    } catch (error) {
      problems.push(`${spec.key}: cannot be opened (${error.message})`)
    }
  }
  if (!shallow && !remote) {
    const dir = join(repo, "catalog", id)
    const listed = new Set(assets.flatMap((spec) => (spec.parts || []).map((part) => String(part?.url || "").slice(REPO_RAW.length))))
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!listed.has(`catalog/${id}/${name}`)) problems.push(`catalog/${id}/${name} is not listed in assets; remove old versions`)
      }
    }
  }
  if (facts.mapBounds) {
    for (const key of ["places", "roads", "buildings"]) {
      if (facts[key] && !rangeOverlaps(facts[key], facts.mapBounds)) problems.push(`${key}: data lies outside the basemap bounds, wrong country?`)
    }
  }
  const counts = Object.entries(facts.counts).map(([key, value]) => `${key} ${value}`).join(", ")
  if (problems.length) {
    failures += 1
    console.log(`FAIL ${id}`)
    for (const problem of problems) console.log(`  - ${problem}`)
  } else console.log(`ok   ${id}: ${shallow ? "JSON checked" : `${checked}/${REQUIRED.length - builtIn.size} files opened`}${counts ? ` (${counts})` : ""}`)
}

let index = ""
try {
  index = readFileSync(join(repo, "catalog", INDEX_NAME), "utf8")
} catch {
  /* missing */
}
if (index !== buildIndex(repo)) {
  console.log(`FAIL catalog/${INDEX_NAME} is out of date: run node scripts/make-index.mjs and commit it`)
  failures += 1
}

if (failures) {
  console.log(`\n${failures} problem(s): see SPEC.md`)
  process.exit(1)
}
