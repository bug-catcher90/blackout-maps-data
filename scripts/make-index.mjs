// Writes catalog/index.json, the one file the apps read to list packages.
//
//   node scripts/make-index.mjs           rewrite catalog/index.json
//   node scripts/make-index.mjs --check   exit 1 when catalog/index.json is out of date
//
// The index holds every catalog/<id>.json entry as it is, sorted by id. Bump INDEX_FORMAT only for changes old apps cannot read;
// the apps ignore an index whose format they do not know.
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const INDEX_FORMAT = 1
export const INDEX_NAME = "index.json"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export function buildIndex(root = repo) {
  const dir = join(root, "catalog")
  const packages = readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== INDEX_NAME)
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")))
  return `${JSON.stringify({ format: INDEX_FORMAT, packages }, null, 1)}\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = join(repo, "catalog", INDEX_NAME)
  const next = buildIndex()
  if (process.argv.includes("--check")) {
    let current = ""
    try {
      current = readFileSync(path, "utf8")
    } catch {
      /* missing */
    }
    if (current !== next) {
      console.log("FAIL catalog/index.json is out of date: run node scripts/make-index.mjs and commit it")
      process.exit(1)
    }
    console.log("ok   catalog/index.json lists every package")
  } else {
    writeFileSync(path, next)
    console.error(`wrote ${path}`)
  }
}
