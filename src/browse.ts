/**
 * `package serve` — a read-only-plus-delete local web UI over the shared
 * store, served by Hono on 127.0.0.1.
 *
 * The UI itself is a Svelte SPA built ahead of time into one self-contained
 * HTML file (src/browserui/app.html via vite-plugin-singlefile) and served at
 * `/`; the API routes below feed it. stdout keeps the single-envelope
 * contract and carries the server URL; human status lines go to stderr. The
 * command runs until the process-wide interrupt signal fires.
 */

import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ServerType, serve } from "@hono/node-server"
import { Hono } from "hono"

import { envForConfigPath, storeDir } from "./config"
import { usageError } from "./errors"
import { status } from "./format"
import { GEN_CONFIG_MEDIA_TYPE } from "./genPackage"
import { interruptSignal } from "./interrupt"
import { type FsView, mergeImageLayers, normalizeTarPath } from "./layers"
import {
  digestHex,
  type IndexEntry,
  type OCIManifest,
  REF_NAME_ANNOTATION,
  readIndexEntries,
} from "./oci"
import { emitResult } from "./output"

/** Gen-package summary shown in the list (from the config blob). */
interface BrowserGenMeta {
  task: string
  provider?: string
  model?: string
  createdAt?: string
}

export interface BrowserEntry {
  ref: string
  digest: string
  size: number
  kind: "gen" | "image"
  annotations: Record<string, string>
  gen?: BrowserGenMeta
  /** URL path of a previewable media file, for the gallery card cover. */
  cover?: string
}

/** One file of a package's merged layer view, as seen by the UI. */
export interface PackageFile {
  path: string
  type: "file" | "dir" | "symlink"
  size?: number
  target?: string
}

export interface PackageDetail {
  ref: string
  digest: string
  size: number
  kind: "gen" | "image"
  annotations: Record<string, string>
  /** Parsed config blob sections, when the package carries a gen config. */
  gen?: Record<string, unknown>
  result?: Record<string, unknown>
  files: PackageFile[]
}

/** Result shape of the injected removeRefs operation (store.ts's RemoveResult). */
export interface RemoveRefsResult {
  untagged: string[]
  deletedBlobs: string[]
}

const VIEW_CACHE_MAX = 16

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  log: "text/plain; charset=utf-8",
  pdf: "application/pdf",
}

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return MIME_TYPES[ext] ?? "application/octet-stream"
}

function isPreviewableMedia(path: string): boolean {
  const type = contentTypeFor(path)
  return (type.startsWith("image/") || type.startsWith("video/")) && type !== "image/svg+xml"
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function strField(rec: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = rec?.[key]
  return typeof value === "string" ? value : undefined
}

function blobPath(store: string, digest: string): string {
  return join(store, "blobs", "sha256", digestHex(digest))
}

export function fileUrl(ref: string, filePath: string): string {
  return `/package/${encodeURIComponent(ref)}/file/${encodeURIComponent(filePath)}`
}

// --- store reads ---

interface EntryMeta {
  kind: "gen" | "image"
  gen?: BrowserGenMeta
  coverName?: string
}

async function describeEntry(store: string, digest: string): Promise<EntryMeta> {
  let manifest: { config?: { mediaType?: string; digest?: string } }
  try {
    manifest = JSON.parse(await readFile(blobPath(store, digest), "utf8"))
  } catch {
    // manifest blob missing — still list the tag with its index-level metadata
    return { kind: "image" }
  }
  if (
    manifest.config?.mediaType !== GEN_CONFIG_MEDIA_TYPE ||
    manifest.config.digest === undefined
  ) {
    return { kind: "image" }
  }
  let config: Record<string, unknown> | undefined
  try {
    config = asRecord(JSON.parse(await readFile(blobPath(store, manifest.config.digest), "utf8")))
  } catch {
    config = undefined // unreadable config — the summary stays generic
  }
  const genRec = asRecord(config?.["gen"])
  const resultRec = asRecord(config?.["result"])
  const gen: BrowserGenMeta = { task: strField(genRec, "task") ?? "unknown" }
  const provider = strField(genRec, "provider")
  if (provider !== undefined) gen.provider = provider
  const model = strField(genRec, "model")
  if (model !== undefined) gen.model = model
  const createdAt = strField(resultRec, "createdAt")
  if (createdAt !== undefined) gen.createdAt = createdAt
  const coverName = coverNameFromResult(resultRec)
  return {
    kind: "gen",
    ...(coverName === undefined ? {} : { coverName }),
    gen,
  }
}

/** First previewable artifact name of a gen result (cover candidate). */
function coverNameFromResult(resultRec: Record<string, unknown> | undefined): string | undefined {
  const artifacts = Array.isArray(resultRec?.["artifacts"]) ? resultRec["artifacts"] : []
  for (const a of artifacts) {
    const name = strField(asRecord(a), "name")
    if (name !== undefined && isPreviewableMedia(name)) return name
  }
  return undefined
}

/** List store tags with annotations and, for gen packages, a config summary. */
export async function browserEntries(configPath?: string): Promise<BrowserEntry[]> {
  return browserEntriesStore(storeDir(envForConfigPath(configPath)))
}

async function browserEntriesStore(store: string): Promise<BrowserEntry[]> {
  const out: BrowserEntry[] = []
  for (const e of await readIndexEntries(store)) {
    const ref = e.annotations?.[REF_NAME_ANNOTATION]
    if (ref === undefined) continue
    const meta = await describeEntry(store, e.digest)
    const coverName = meta.coverName === undefined ? undefined : fileUrl(ref, meta.coverName)
    out.push({
      ref,
      digest: e.digest,
      size: e.size,
      kind: meta.kind,
      annotations: e.annotations ?? {},
      ...(meta.gen === undefined ? {} : { gen: meta.gen }),
      ...(coverName === undefined ? {} : { cover: coverName }),
    })
  }
  return out
}

/** The merged layer view for a manifest, memoized per digest (bounded FIFO). */
async function cachedView(
  store: string,
  digest: string,
  manifest: OCIManifest,
  cache: Map<string, FsView>,
): Promise<FsView> {
  const hit = cache.get(digest)
  if (hit !== undefined) return hit
  const blobs: Buffer[] = []
  for (const layer of manifest.layers ?? []) {
    blobs.push(await readFile(blobPath(store, layer.digest)))
  }
  const view = blobs.length === 0 ? new Map() : (await mergeImageLayers(blobs)).view
  cache.set(digest, view)
  if (cache.size > VIEW_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return view
}

/** A loaded package: the JSON-friendly detail plus its raw merged view. */
interface LoadedPackage {
  detail: PackageDetail
  view: FsView
}

/** Load one package: manifest, config blob, and the merged layer file view. */
async function loadPackage(
  store: string,
  ref: string,
  cache: Map<string, FsView>,
): Promise<LoadedPackage | undefined> {
  const entries = await readIndexEntries(store)
  const entry: IndexEntry | undefined = entries.find(
    (e) => e.annotations?.[REF_NAME_ANNOTATION] === ref,
  )
  if (entry === undefined) return undefined

  const manifest = JSON.parse(await readFile(blobPath(store, entry.digest), "utf8")) as OCIManifest
  const isGen = manifest.config?.mediaType === GEN_CONFIG_MEDIA_TYPE
  let config: Record<string, unknown> | undefined
  if (manifest.config !== undefined) {
    try {
      config = asRecord(JSON.parse(await readFile(blobPath(store, manifest.config.digest), "utf8")))
    } catch {
      config = undefined // metadata sections simply stay hidden
    }
  }
  const view = await cachedView(store, entry.digest, manifest, cache)

  const files: PackageFile[] = [...view.keys()].sort().map((path) => {
    const e = view.get(path)
    if (e?.type === "file") return { path, type: "file" as const, size: e.data.length }
    if (e?.type === "symlink") return { path, type: "symlink" as const, target: e.target }
    return { path, type: "dir" as const }
  })
  const genRec = isGen ? asRecord(config?.["gen"]) : undefined
  const resultRec = isGen ? asRecord(config?.["result"]) : undefined

  return {
    detail: {
      ref,
      digest: entry.digest,
      size: entry.size,
      kind: isGen ? "gen" : "image",
      annotations: entry.annotations ?? {},
      ...(genRec === undefined ? {} : { gen: genRec }),
      ...(resultRec === undefined ? {} : { result: resultRec }),
      files,
    },
    view,
  }
}

// --- the SPA bundle ---

const APP_HTML_URL = new URL("./browserui/app.html", import.meta.url)
let appHtmlCache: string | undefined

/** Read the prebuilt single-file Svelte app (built by `npm run build:ui` + scripts/emit-ui.mjs). */
async function loadAppHtml(): Promise<string> {
  appHtmlCache ??= await readFile(APP_HTML_URL, "utf8").catch(() => {
    throw new Error(
      `browser UI bundle not found at ${fileURLToPath(APP_HTML_URL)} — run 'npm run build' (or 'npm run build:ui' then 'node scripts/emit-ui.mjs') first`,
    )
  })
  return appHtmlCache
}

// --- Hono app ---

/** Security headers for the SPA shell: everything it needs is inline. */
const SPA_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  "X-Content-Type-Options": "nosniff",
}

/** Raw blobs must never run as documents in the server's origin. */
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'"

interface RequestCtx {
  store: string
  viewCache: Map<string, FsView>
  /** Untag refs + GC unreachable blobs (docker rmi semantics); injected. */
  removeRefs?: ((refs: string[]) => Promise<RemoveRefsResult>) | undefined
}

function createBrowserApp(ctx: RequestCtx): Hono {
  const app = new Hono()

  // WSL2's localhost relay (a proxy between the Windows browser and this
  // WSL-bound server) can stall requests sent over a reused keep-alive
  // connection. A single-user local tool loses nothing by closing the
  // connection after every response — each browser request then opens a
  // fresh one, which the relay handles reliably.
  app.use("*", async (c, next) => {
    await next()
    c.res.headers.set("Connection", "close")
  })

  app.get("/", async (c) => c.html(await loadAppHtml(), 200, SPA_HEADERS))
  app.get("/index.html", async (c) => c.html(await loadAppHtml(), 200, SPA_HEADERS))

  app.get("/api/packages", async (c) => c.json(await browserEntriesStore(ctx.store)))

  app.get("/api/packages/:ref", async (c) => {
    const loaded = await loadPackage(ctx.store, c.req.param("ref"), ctx.viewCache)
    if (loaded === undefined) return c.json({ error: "package not in store" }, 404)
    return c.json(loaded.detail)
  })

  app.delete("/api/packages/:ref", async (c) => {
    const ref = c.req.param("ref")
    if (ctx.removeRefs === undefined) return c.json({ error: "deletion unavailable" }, 501)
    const inStore = (await browserEntriesStore(ctx.store)).some((e) => e.ref === ref)
    if (!inStore) return c.json({ error: "package not in store" }, 404)
    return c.json(await ctx.removeRefs([ref]))
  })

  // `:path{.+}` keeps slashes inside one param; Hono percent-decodes params,
  // normalizeTarPath still rejects absolute paths and .. traversal.
  app.get("/package/:ref/file/:path{.+}", async (c) => {
    const loaded = await loadPackage(ctx.store, c.req.param("ref"), ctx.viewCache)
    if (loaded === undefined) return c.json({ error: "package not in store" }, 404)
    const filePath = c.req.param("path")
    const normalized = normalizeTarPath(filePath)
    const entry = normalized === null ? undefined : loaded.view.get(normalized)
    if (normalized === null || entry === undefined || entry.type !== "file") {
      return c.json({ error: "file not in package" }, 404)
    }
    return c.body(new Uint8Array(entry.data), 200, {
      "Content-Type": contentTypeFor(normalized),
      "Content-Security-Policy": FILE_CSP,
      "X-Content-Type-Options": "nosniff",
    })
  })

  app.notFound((c) => c.json({ error: "not found" }, 404))
  return app
}

export interface BrowserServer {
  url: string
  port: number
  close(): Promise<void>
}

/**
 * Start the store browser server on 127.0.0.1 (localhost only — the store
 * may hold private artifacts). `port` 0 (default) picks a random free port.
 */
export async function startStoreBrowserServer(
  opts: {
    configPath?: string | undefined
    port?: number | undefined
    removeRefs?: ((refs: string[]) => Promise<RemoveRefsResult>) | undefined
  } = {},
): Promise<BrowserServer> {
  const ctx: RequestCtx = {
    store: storeDir(envForConfigPath(opts.configPath)),
    viewCache: new Map(),
    removeRefs: opts.removeRefs,
  }
  const server: ServerType = serve({
    fetch: createBrowserApp(ctx).fetch,
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
  })
  await new Promise<void>((resolve, reject) => {
    if (server.listening) return resolve()
    server.once("listening", () => resolve())
    server.once("error", reject)
  })
  const { port } = server.address() as { port: number }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        // ServerType unions http2 variants without this method; we always
        // serve plain http1 on 127.0.0.1.
        ;(server as import("node:http").Server).closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** Open a URL in the system browser; a missing opener is not an error. */
function openInBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]]
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" })
  child.on("error", () => {})
  child.unref()
}

/** Validate the --port flag; undefined means "pick a random free port". */
export function parseBrowserPort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw usageError(`--port expects a port number (0 for a random free port), got '${raw}'`)
  }
  return port
}

/**
 * The `package serve` command body: start the server, emit the JSON envelope
 * (carrying the URL) on stdout, tell the human on stderr, optionally launch
 * the browser (only with --browser), then run until interrupted.
 */
export async function serveStoreBrowser(opts: {
  configPath?: string | undefined
  port?: number | undefined
  open?: boolean | undefined
  pretty?: boolean | undefined
  removeRefs?: ((refs: string[]) => Promise<RemoveRefsResult>) | undefined
}): Promise<void> {
  const handle = await startStoreBrowserServer({
    configPath: opts.configPath,
    port: opts.port,
    removeRefs: opts.removeRefs,
  })
  emitResult("package.serve", { url: handle.url }, { pretty: opts.pretty })
  status(`serving the store at ${handle.url} — press Ctrl-C to stop`)
  if (opts.open === true) openInBrowser(handle.url)
  await new Promise<void>((resolve) => {
    interruptSignal().addEventListener(
      "abort",
      () => {
        void handle.close().then(
          () => resolve(),
          () => resolve(),
        )
      },
      { once: true },
    )
  })
}
