// Minimal PMTiles v3 reader and writer for local files.
// Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
import { closeSync, openSync, readSync, writeSync } from "node:fs"
import { gunzipSync, gzipSync } from "node:zlib"

const HEADER_BYTES = 127
const ROOT_MAX = 16384 - HEADER_BYTES

function readVarint(buf, state) {
  let result = 0
  let shift = 0
  for (;;) {
    const byte = buf[state.pos++]
    result += (byte & 0x7f) * 2 ** shift
    if (byte < 0x80) return result
    shift += 7
  }
}

function writeVarint(out, value) {
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80)
    value = Math.floor(value / 0x80)
  }
  out.push(value)
}

function u64(view, at) {
  return Number(view.getBigUint64(at, true))
}

function decompress(buf, kind) {
  if (kind === 1 || kind === 0) return buf
  if (kind === 2) return gunzipSync(buf)
  throw new Error(`unsupported compression ${kind}`)
}

function deserializeDirectory(buf) {
  const state = { pos: 0 }
  const count = readVarint(buf, state)
  const entries = new Array(count)
  let last = 0
  for (let i = 0; i < count; i += 1) {
    last += readVarint(buf, state)
    entries[i] = { tileId: last, runLength: 0, length: 0, offset: 0 }
  }
  for (let i = 0; i < count; i += 1) entries[i].runLength = readVarint(buf, state)
  for (let i = 0; i < count; i += 1) entries[i].length = readVarint(buf, state)
  for (let i = 0; i < count; i += 1) {
    const value = readVarint(buf, state)
    entries[i].offset = value === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : value - 1
  }
  return entries
}

function serializeDirectory(entries) {
  const out = []
  writeVarint(out, entries.length)
  let last = 0
  for (const entry of entries) {
    writeVarint(out, entry.tileId - last)
    last = entry.tileId
  }
  for (const entry of entries) writeVarint(out, entry.runLength)
  for (const entry of entries) writeVarint(out, entry.length)
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (i > 0 && entry.offset === entries[i - 1].offset + entries[i - 1].length) writeVarint(out, 0)
    else writeVarint(out, entry.offset + 1)
  }
  return gzipSync(Buffer.from(out))
}

export function openArchive(path) {
  const fd = openSync(path, "r")
  const read = (offset, length) => {
    const buf = Buffer.alloc(length)
    let got = 0
    while (got < length) got += readSync(fd, buf, got, length - got, offset + got)
    return buf
  }
  const raw = read(0, HEADER_BYTES)
  if (raw.toString("latin1", 0, 7) !== "PMTiles" || raw[7] !== 3) throw new Error(`${path}: not a PMTiles v3 archive`)
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const header = {
    rootOffset: u64(view, 8),
    rootLength: u64(view, 16),
    metadataOffset: u64(view, 24),
    metadataLength: u64(view, 32),
    leafOffset: u64(view, 40),
    leafLength: u64(view, 48),
    dataOffset: u64(view, 56),
    dataLength: u64(view, 64),
    addressedTiles: u64(view, 72),
    tileEntries: u64(view, 80),
    tileContents: u64(view, 88),
    clustered: raw[96],
    internalCompression: raw[97],
    tileCompression: raw[98],
    tileType: raw[99],
    minZoom: raw[100],
    maxZoom: raw[101],
    minLonE7: view.getInt32(102, true),
    minLatE7: view.getInt32(106, true),
    maxLonE7: view.getInt32(110, true),
    maxLatE7: view.getInt32(114, true),
    centerZoom: raw[118],
    centerLonE7: view.getInt32(119, true),
    centerLatE7: view.getInt32(123, true),
  }
  const directory = (offset, length) => deserializeDirectory(decompress(read(offset, length), header.internalCompression))
  const metadata = () => JSON.parse(decompress(read(header.metadataOffset, header.metadataLength), header.internalCompression).toString("utf8") || "{}")

  // Yields every tile entry (run lengths kept) in tile-id order.
  function* entries() {
    const walk = function* (list) {
      for (const entry of list) {
        if (entry.runLength === 0) yield* walk(directory(header.leafOffset + entry.offset, entry.length))
        else yield entry
      }
    }
    yield* walk(directory(header.rootOffset, header.rootLength))
  }

  const tileData = (entry) => read(header.dataOffset + entry.offset, entry.length)
  return { header, metadata, entries, tileData, close: () => closeSync(fd) }
}

function buildDirectories(entries) {
  const root = serializeDirectory(entries)
  if (root.length <= ROOT_MAX) return { root, leaves: Buffer.alloc(0) }
  let leafSize = 4096
  for (;;) {
    const rootEntries = []
    const leafParts = []
    let leafBytes = 0
    for (let i = 0; i < entries.length; i += leafSize) {
      const chunk = entries.slice(i, i + leafSize)
      const leaf = serializeDirectory(chunk)
      rootEntries.push({ tileId: chunk[0].tileId, runLength: 0, length: leaf.length, offset: leafBytes })
      leafParts.push(leaf)
      leafBytes += leaf.length
    }
    const rootDir = serializeDirectory(rootEntries)
    if (rootDir.length <= ROOT_MAX) return { root: rootDir, leaves: Buffer.concat(leafParts) }
    leafSize *= 2
  }
}

// Writes tiles to `path`. `tiles` must be pushed in ascending tile-id order.
export function createWriter(path, tmpPath) {
  const dataFd = openSync(tmpPath, "w")
  const entries = []
  const seen = new Map()
  let dataLength = 0
  let addressed = 0
  let contents = 0
  return {
    add(tileId, bytes, hashKey) {
      addressed += 1
      const last = entries[entries.length - 1]
      const known = hashKey ? seen.get(hashKey) : undefined
      if (known) {
        if (last && last.offset === known.offset && last.tileId + last.runLength === tileId) last.runLength += 1
        else entries.push({ tileId, runLength: 1, length: known.length, offset: known.offset })
        return
      }
      const offset = dataLength
      writeSync(dataFd, bytes)
      dataLength += bytes.length
      contents += 1
      if (hashKey) seen.set(hashKey, { offset, length: bytes.length })
      entries.push({ tileId, runLength: 1, length: bytes.length, offset })
    },
    finish(header, metadata) {
      closeSync(dataFd)
      const { root, leaves } = buildDirectories(entries)
      const meta = gzipSync(Buffer.from(JSON.stringify(metadata)))
      const out = Buffer.alloc(HEADER_BYTES)
      const view = new DataView(out.buffer)
      out.write("PMTiles", 0, "latin1")
      out[7] = 3
      const rootOffset = HEADER_BYTES
      const metadataOffset = rootOffset + root.length
      const leafOffset = metadataOffset + meta.length
      const dataOffset = leafOffset + leaves.length
      const set = (at, value) => view.setBigUint64(at, BigInt(value), true)
      set(8, rootOffset)
      set(16, root.length)
      set(24, metadataOffset)
      set(32, meta.length)
      set(40, leafOffset)
      set(48, leaves.length)
      set(56, dataOffset)
      set(64, dataLength)
      set(72, addressed)
      set(80, entries.length)
      set(88, contents)
      out[96] = 1
      out[97] = 2
      out[98] = header.tileCompression
      out[99] = header.tileType
      out[100] = header.minZoom
      out[101] = header.maxZoom
      view.setInt32(102, header.minLonE7, true)
      view.setInt32(106, header.minLatE7, true)
      view.setInt32(110, header.maxLonE7, true)
      view.setInt32(114, header.maxLatE7, true)
      out[118] = header.centerZoom
      view.setInt32(119, header.centerLonE7, true)
      view.setInt32(123, header.centerLatE7, true)
      return { prefix: Buffer.concat([out, root, meta, leaves]), dataLength, entries: entries.length, contents, addressed }
    },
  }
}
