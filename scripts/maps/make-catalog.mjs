#!/usr/bin/env node
// Usage: node make-catalog.mjs <id> <work-dir> <repo-dir>
// Splits the files built by build-country.sh into parts in catalog/<id>/,
// removes anything else from that folder, and writes catalog/<id>.json.
// See SPEC.md. BASE_URL overrides where the parts are served from.
import { createHash } from "node:crypto"
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createGunzip } from "node:zlib"
import { openArchive } from "./lib/pmtiles.mjs"

export const PART_BYTES = 45_000_000

const FILES = [
  { key: "places", file: "places.bin", label: "lugares" },
  { key: "water", file: "water.bin", label: "água" },
  { key: "addresses", file: "addresses.bin", label: "moradas" },
  { key: "geo", file: "geo.json", label: "geo" },
  { key: "roads", file: "roads.bin", label: "estradas" },
  { key: "buildings", file: "buildings.bin", label: "edifícios" },
  { key: "map", file: "map.pmtiles", label: "mapa", plain: true },
]
// Keys the 1.0 apps open correctly from a single URL. Only these go in the
// compatibility list `files`; every key is in `assets`.
const LEGACY_KEYS = new Set(["places", "water", "addresses", "geo", "roads"])

function sha256(stream) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    let bytes = 0
    stream.on("data", (chunk) => {
      hash.update(chunk)
      bytes += chunk.length
    })
    stream.on("error", reject)
    stream.on("end", () => resolve({ sha256: hash.digest("hex"), bytes }))
  })
}

function splitInto(packed, dir, name) {
  const size = statSync(packed).size
  const count = Math.max(1, Math.ceil(size / PART_BYTES))
  const names = count === 1 ? [name] : Array.from({ length: count }, (_, i) => `${name}.${String(i).padStart(3, "0")}`)
  const fd = openSync(packed, "r")
  const parts = []
  try {
    for (let i = 0; i < count; i += 1) {
      const length = Math.min(PART_BYTES, size - i * PART_BYTES)
      const buf = Buffer.alloc(length)
      let got = 0
      while (got < length) got += readSync(fd, buf, got, length - got, i * PART_BYTES + got)
      writeFileSync(join(dir, names[i]), buf)
      parts.push({ name: names[i], bytes: length, sha256: createHash("sha256").update(buf).digest("hex") })
    }
  } finally {
    closeSync(fd)
  }
  return parts
}

async function main() {
  const [id, work, repo] = process.argv.slice(2)
  if (!id || !work || !repo) {
    console.error("usage: make-catalog.mjs <id> <work-dir> <repo-dir>")
    process.exit(2)
  }
  const countries = JSON.parse(readFileSync(fileURLToPath(new URL("./countries.json", import.meta.url)), "utf8"))
  const country = countries.find((row) => row.id === id)
  if (!country) throw new Error(`unknown country ${id}`)
  const keep = new Set(country.keep || [])
  const base = (process.env.BASE_URL || `https://raw.githubusercontent.com/bug-catcher90/blackout-maps-data/main/catalog/${id}`).replace(/\/$/, "")
  const out = join(work, "out")
  const dir = join(repo, "catalog", id)
  mkdirSync(dir, { recursive: true })

  const written = new Set()
  const assets = []
  for (const spec of FILES) {
    const packedName = spec.plain ? spec.file : `${spec.file}.gz`
    const kept = keep.has(spec.key)
    // Kept files are the ones already committed in catalog/<id>/, left as they are.
    const packed = kept ? join(dir, packedName) : join(out, packedName)
    if (!existsSync(packed)) throw new Error(`missing ${packed}`)
    const whole = await sha256(spec.plain ? createReadStream(packed) : createReadStream(packed).pipe(createGunzip()))
    let parts
    if (kept) {
      if (statSync(packed).size > PART_BYTES) throw new Error(`${packed} is over ${PART_BYTES} bytes`)
      parts = [{ name: packedName, bytes: statSync(packed).size, sha256: (await sha256(createReadStream(packed))).sha256 }]
    } else {
      parts = splitInto(packed, dir, packedName)
    }
    for (const part of parts) written.add(part.name)
    assets.push({
      key: spec.key,
      file: spec.file,
      gzip: !spec.plain,
      bytes: whole.bytes,
      sha256: whole.sha256,
      label: spec.label,
      parts: parts.map((part) => ({ url: `${base}/${part.name}`, bytes: part.bytes, sha256: part.sha256 })),
    })
    console.error(`${id} ${spec.key}: ${parts.length} part(s), ${(parts.reduce((n, p) => n + p.bytes, 0) / 1e6).toFixed(1)} MB`)
  }
  for (const name of readdirSync(dir)) {
    if (!written.has(name)) rmSync(join(dir, name), { recursive: true })
  }

  const files = assets
    .filter((asset) => LEGACY_KEYS.has(asset.key) && asset.parts.length === 1 && !(country.autoload && asset.key === "roads"))
    .map((asset) => ({ key: asset.key, url: asset.parts[0].url, file: asset.file, gzip: asset.gzip, bytes: asset.bytes, label: asset.label }))
  // Where the app frames the package after it is chosen: [lon, lat, zoom].
  const archive = openArchive(join(out, "map.pmtiles"))
  const { minLonE7, minLatE7, maxLonE7, maxLatE7 } = archive.header
  archive.close()
  const [west, south, east, north] = [minLonE7, minLatE7, maxLonE7, maxLatE7].map((v) => v / 1e7)
  const span = Math.max(east - west, (north - south) * 1.6)
  const view = [
    Number(((west + east) / 2).toFixed(3)),
    Number(((south + north) / 2).toFixed(3)),
    Number(Math.min(10, Math.max(4, Math.log2(360 / span) + 0.2)).toFixed(1)),
  ]
  const read = (name) => (existsSync(join(work, name)) ? readFileSync(join(work, name), "utf8").trim() : "")
  const entry = {
    id,
    name: country.name,
    flag: country.flag,
    autoload: Boolean(country.autoload),
    ...(country.country ? { country: country.country } : {}),
    view,
    files,
    assets,
    source: {
      osm: `https://download.geofabrik.de/${country.geofabrik}-latest.osm.pbf`,
      osmTimestamp: read("osm-timestamp.txt") || null,
      basemap: read("planet-url.txt") || null,
    },
  }
  if (keep.size) entry.source.kept = [...keep]
  const output = join(repo, "catalog", `${id}.json`)
  writeFileSync(output, `${JSON.stringify(entry, null, 2)}\n`)
  console.error(`wrote ${output}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
