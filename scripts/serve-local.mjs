// Serves this checkout's catalog so the web app can load packages before they are merged.
//
//   node scripts/serve-local.mjs [port]      (default 8000)
//
// Then open the app repository's web app, served on localhost, with
//   http://localhost:<app-port>/maps/?catalog=http://127.0.0.1:8000/catalog/index.json
// /catalog/index.json is built on the fly with every part URL pointing at this server.
import { createReadStream, existsSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildIndex } from "./make-index.mjs"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const port = Number(process.argv[2] || 8000)
const REMOTE = "https://raw.githubusercontent.com/bug-catcher90/blackout-maps-data/main/"

createServer((request, response) => {
  const base = `http://${request.headers.host || `127.0.0.1:${port}`}/`
  const path = decodeURIComponent(new URL(request.url, base).pathname)
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Range", "Accept-Ranges": "bytes" }
  if (request.method === "OPTIONS") return response.writeHead(204, headers).end()
  if (path === "/catalog/index.json") {
    const body = buildIndex(repo).split(REMOTE).join(base)
    return response.writeHead(200, { ...headers, "Content-Type": "application/json" }).end(body)
  }
  const file = normalize(join(repo, path))
  if (!file.startsWith(join(repo, "catalog")) || !existsSync(file) || !statSync(file).isFile()) {
    return response.writeHead(404, headers).end("not found")
  }
  const size = statSync(file).size
  const range = /^bytes=(\d+)-$/.exec(request.headers.range || "")
  if (range && Number(range[1]) < size) {
    const start = Number(range[1])
    response.writeHead(206, { ...headers, "Content-Length": size - start, "Content-Range": `bytes ${start}-${size - 1}/${size}` })
    return createReadStream(file, { start }).pipe(response)
  }
  response.writeHead(200, { ...headers, "Content-Length": size })
  createReadStream(file).pipe(response)
}).listen(port, "127.0.0.1", () => console.error(`catalog at http://127.0.0.1:${port}/catalog/index.json`))
