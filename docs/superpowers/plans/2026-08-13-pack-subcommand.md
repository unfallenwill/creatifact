# pack 子命令 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 openmmcli 添加 `pack` 子命令,将本地目录打包为符合 OCI image-spec 的 image layout 目录。

**Architecture:** 新增 `src/pack.ts` 承载全部打包逻辑:OCI 类型定义、manifest 构建、tar.gz 层生成(流式 + sha256)、OCI layout 写入、argv 解析、描述文件加载、选项合并、orchestrator。`src/index.ts` 增加子命令分派——首个非 flag 参数为 `pack` 时转入打包流程,否则保持现有交互式演示。

**Tech Stack:** TypeScript(strict)、tar-stream v3、Node.js crypto/zlib/fs/stream、Vitest、Biome

## Global Constraints

- Node.js >= 20.0.0,ESM only("type": "module")
- Biome:2 空格缩进、双引号、无分号、lineWidth 100、max cognitive complexity 15
- tsconfig:strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + verbatimModuleSyntax + noPropertyAccessFromIndexSignature
- 不引入 CLI 解析库(argv 手写解析)
- tar 内路径为目录内容的相对路径,不带顶层目录前缀
- digest 格式:`sha256:<hex>`,blob 存储路径为 `blobs/sha256/<hex>`
- config mediaType 为 `application/vnd.oci.image.config.v1+json`,内容为 `{}`
- manifest 含用户 annotations;index.json 的 manifest entry 含 `org.opencontainers.image.ref.name` annotation

## File Structure

- **Create:** `src/pack.ts` — 全部打包逻辑(类型、函数、orchestrator)
- **Create:** `src/__tests__/pack.test.ts` — 单元测试
- **Modify:** `src/index.ts` — 子命令分派(首个非 flag 参数)
- **Modify:** `src/__tests__/cli.test.ts` — pack 集成测试
- **Modify:** `package.json` — 新增 tar-stream 依赖

---

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `tar-stream` 运行时依赖可用,TypeScript 类型可解析

- [ ] **Step 1: Install tar-stream**

Run:
```bash
npm install tar-stream
```

- [ ] **Step 2: Verify TypeScript types resolve**

Run:
```bash
npx tsc --noEmit 2>&1 | head -5
```

Expected: 无关于 `tar-stream` 的 "Could not find declaration file" 错误。tar-stream v3+ 自带类型。若报错,执行 `npm install -D @types/tar-stream` 并重新检查。

- [ ] **Step 3: Verify build succeeds**

Run:
```bash
npm run build
```

Expected: 构建成功,dist/index.mjs 更新。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add tar-stream dependency for pack subcommand"
```

---

### Task 2: OCI types + buildManifest

**Files:**
- Create: `src/pack.ts`
- Test: `src/__tests__/pack.test.ts`

**Interfaces:**
- Produces:
  - `OCIDescriptor` 类型:`{ mediaType: string; digest: string; size: number }`
  - `OCIManifest` 类型:`{ schemaVersion: 2; mediaType: string; config: OCIDescriptor; layers: OCIDescriptor[]; annotations?: Record<string, string> }`
  - `buildManifest(config: OCIDescriptor, layer: OCIDescriptor, annotations: Record<string, string>): OCIManifest`
  - 常量 `MANIFEST_MEDIA_TYPE`、`CONFIG_MEDIA_TYPE`、`LAYER_MEDIA_TYPE`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/pack.test.ts`:

```ts
import { buildManifest, type OCIDescriptor } from "../pack"

test("buildManifest produces valid OCI manifest with annotations", () => {
  const config: OCIDescriptor = {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest: "sha256:abc",
    size: 2,
  }
  const layer: OCIDescriptor = {
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    digest: "sha256:def",
    size: 100,
  }
  const annotations = { "org.openmm.platform": "CUDA" }

  const manifest = buildManifest(config, layer, annotations)

  expect(manifest.schemaVersion).toBe(2)
  expect(manifest.mediaType).toBe("application/vnd.oci.image.manifest.v1+json")
  expect(manifest.config).toEqual(config)
  expect(manifest.layers).toEqual([layer])
  expect(manifest.annotations).toEqual(annotations)
})

test("buildManifest omits annotations when empty", () => {
  const config: OCIDescriptor = {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest: "sha256:abc",
    size: 2,
  }
  const layer: OCIDescriptor = {
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    digest: "sha256:def",
    size: 100,
  }

  const manifest = buildManifest(config, layer, {})

  expect(manifest.annotations).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/pack.test.ts`
Expected: FAIL — `Cannot find module '../pack'`

- [ ] **Step 3: Write minimal implementation**

Create `src/pack.ts`:

```ts
export interface OCIDescriptor {
  mediaType: string
  digest: string
  size: number
}

export interface OCIManifest {
  schemaVersion: 2
  mediaType: string
  config: OCIDescriptor
  layers: OCIDescriptor[]
  annotations?: Record<string, string>
}

export const MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json"
export const CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json"
export const LAYER_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip"

export function buildManifest(
  config: OCIDescriptor,
  layer: OCIDescriptor,
  annotations: Record<string, string>,
): OCIManifest {
  const base: OCIManifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config,
    layers: [layer],
  }
  if (Object.keys(annotations).length > 0) {
    return { ...base, annotations }
  }
  return base
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/pack.test.ts`
Expected: PASS — 2 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/pack.ts src/__tests__/pack.test.ts
git commit -m "feat(pack): add OCI types and buildManifest"
```

---

### Task 3: writeBlob + createLayerTarball

**Files:**
- Modify: `src/pack.ts`
- Test: `src/__tests__/pack.test.ts`

**Interfaces:**
- Consumes: `OCIDescriptor`, `LAYER_MEDIA_TYPE` from Task 2
- Produces:
  - `writeBlob(data: Buffer, blobsDir: string, mediaType: string): Promise<OCIDescriptor>`
  - `createLayerTarball(dir: string, blobsDir: string): Promise<OCIDescriptor>`

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/pack.test.ts`:

```ts
import { createLayerTarball, writeBlob } from "../pack"
import { gunzipSync } from "node:zlib"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { extract } from "tar-stream"

test("writeBlob writes content and returns correct descriptor", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const blobsDir = join(tmp, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  const content = Buffer.from("{}")
  const desc = await writeBlob(content, blobsDir, "application/vnd.oci.image.config.v1+json")

  expect(desc.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(desc.size).toBe(content.length)
  expect(desc.mediaType).toBe("application/vnd.oci.image.config.v1+json")

  const written = await readFile(join(blobsDir, desc.digest.slice(7)))
  expect(written).toEqual(content)

  await rm(tmp, { recursive: true })
})

test("createLayerTarball packs directory into tar.gz blob", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const srcDir = join(tmp, "src")
  const blobsDir = join(tmp, "blobs", "sha256")
  await mkdir(srcDir, { recursive: true })
  await mkdir(blobsDir, { recursive: true })
  await mkdir(join(srcDir, "sub"), { recursive: true })

  await writeFile(join(srcDir, "hello.txt"), "hello world")
  await writeFile(join(srcDir, "sub", "nested.txt"), "nested content")

  const desc = await createLayerTarball(srcDir, blobsDir)

  expect(desc.mediaType).toBe("application/vnd.oci.image.layer.v1.tar+gzip")
  expect(desc.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(desc.size).toBeGreaterThan(0)

  const blobData = await readFile(join(blobsDir, desc.digest.slice(7)))
  const entries = await extractTarEntries(blobData)
  expect(Object.keys(entries).sort()).toEqual(["hello.txt", "sub/nested.txt"])
  expect(entries["hello.txt"]?.toString()).toBe("hello world")
  expect(entries["sub/nested.txt"]?.toString()).toBe("nested content")

  await rm(tmp, { recursive: true })
})

async function extractTarEntries(gzipData: Buffer): Promise<Record<string, Buffer>> {
  const unzipped = gunzipSync(gzipData)
  const entries: Record<string, Buffer> = {}
  return new Promise((resolve, reject) => {
    const ex = extract()
    ex.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = []
      stream.on("data", (chunk: Buffer) => chunks.push(chunk))
      stream.on("end", () => {
        if (header.name) {
          entries[header.name] = Buffer.concat(chunks)
        }
        next()
      })
    })
    ex.on("finish", () => resolve(entries))
    ex.on("error", reject)
    Readable.from([unzipped]).pipe(ex)
  })
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/pack.test.ts`
Expected: FAIL — `writeBlob` and `createLayerTarball` are not exported

- [ ] **Step 3: Write minimal implementation**

Append to `src/pack.ts` (add new imports at top of file, then functions):

Add to imports section:
```ts
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGzip } from "node:zlib"
import { pack } from "tar-stream"
```

Add functions (after `buildManifest`):

```ts
export async function writeBlob(
  data: Buffer,
  blobsDir: string,
  mediaType: string,
): Promise<OCIDescriptor> {
  const hash = createHash("sha256")
  hash.update(data)
  const hex = hash.digest("hex")
  await writeFile(join(blobsDir, hex), data)
  return {
    mediaType,
    digest: `sha256:${hex}`,
    size: data.length,
  }
}

async function readDirEntries(dir: string, base = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const relPath = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...await readDirEntries(fullPath, relPath))
    } else if (entry.isFile()) {
      files.push(relPath)
    }
  }
  return files
}

export async function createLayerTarball(
  dir: string,
  blobsDir: string,
): Promise<OCIDescriptor> {
  const tempPath = join(blobsDir, ".tmp-layer")
  const fileStream = createWriteStream(tempPath)
  const hash = createHash("sha256")
  let totalSize = 0

  const hashedWriter = new Writable({
    write(chunk, _encoding, callback) {
      hash.update(chunk)
      totalSize += chunk.length
      fileStream.write(chunk, callback)
    },
    final(callback) {
      fileStream.end(() => callback())
    },
  })

  const tarPack = pack()

  const files = await readDirEntries(dir)
  for (const relPath of files) {
    const fullPath = join(dir, relPath)
    const content = await readFile(fullPath)
    const fileStat = await stat(fullPath)
    tarPack.entry({ name: relPath, mode: fileStat.mode & 0o777, size: fileStat.size }, content)
  }
  tarPack.finalize()

  await pipeline(tarPack, createGzip(), hashedWriter)

  const hex = hash.digest("hex")
  const digest = `sha256:${hex}`
  await rename(tempPath, join(blobsDir, hex))

  return {
    mediaType: LAYER_MEDIA_TYPE,
    digest,
    size: totalSize,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/pack.test.ts`
Expected: PASS — 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/pack.ts src/__tests__/pack.test.ts
git commit -m "feat(pack): add writeBlob and createLayerTarball"
```

---

### Task 4: writeOciLayout

**Files:**
- Modify: `src/pack.ts`
- Test: `src/__tests__/pack.test.ts`

**Interfaces:**
- Consumes: `OCIDescriptor` from Task 2
- Produces: `writeOciLayout(outputDir: string, manifestDescriptor: OCIDescriptor, ref: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/pack.test.ts`:

```ts
import { writeOciLayout } from "../pack"
import { existsSync } from "node:fs"

test("writeOciLayout writes oci-layout and index.json", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const manifestDescriptor = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: "sha256:abc123",
    size: 42,
  }

  await writeOciLayout(tmp, manifestDescriptor, "org/plugins:1.0.0")

  const layout = JSON.parse(await readFile(join(tmp, "oci-layout"), "utf8"))
  expect(layout).toEqual({ imageLayoutVersion: "1.0.0" })

  const index = JSON.parse(await readFile(join(tmp, "index.json"), "utf8"))
  expect(index.schemaVersion).toBe(2)
  expect(index.manifests).toHaveLength(1)
  expect(index.manifests[0]).toEqual({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: "sha256:abc123",
    size: 42,
    annotations: { "org.opencontainers.image.ref.name": "org/plugins:1.0.0" },
  })

  await rm(tmp, { recursive: true })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/pack.test.ts`
Expected: FAIL — `writeOciLayout` is not exported

- [ ] **Step 3: Write minimal implementation**

Append to `src/pack.ts`:

```ts
export async function writeOciLayout(
  outputDir: string,
  manifestDescriptor: OCIDescriptor,
  ref: string,
): Promise<void> {
  await writeFile(
    join(outputDir, "oci-layout"),
    JSON.stringify({ imageLayoutVersion: "1.0.0" }),
  )

  const index = {
    schemaVersion: 2,
    manifests: [
      {
        mediaType: manifestDescriptor.mediaType,
        digest: manifestDescriptor.digest,
        size: manifestDescriptor.size,
        annotations: { "org.opencontainers.image.ref.name": ref },
      },
    ],
  }

  await writeFile(join(outputDir, "index.json"), JSON.stringify(index, null, 2))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/pack.test.ts`
Expected: PASS — 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/pack.ts src/__tests__/pack.test.ts
git commit -m "feat(pack): add writeOciLayout for index.json and oci-layout"
```

---

### Task 5: parsePackArgs + loadDescriptionFile + mergeOptions

**Files:**
- Modify: `src/pack.ts`
- Test: `src/__tests__/pack.test.ts`

**Interfaces:**
- Produces:
  - `PackOptions` 类型:`{ name: string; dir: string; output: string; annotations: Record<string, string> }`
  - `ParsedArgs` 类型:`{ dir?: string; name?: string; output?: string; file?: string; annotations: Record<string, string> }`
  - `parsePackArgs(args: string[]): ParsedArgs`
  - `loadDescriptionFile(filePath: string): Promise<Partial<PackOptions & { annotations: Record<string, string> }>>`
  - `mergeOptions(cli: ParsedArgs, desc: Partial<PackOptions & { annotations: Record<string, string> }>): PackOptions`

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/pack.test.ts`:

```ts
import { mergeOptions, parsePackArgs, loadDescriptionFile, type PackOptions } from "../pack"

test("parsePackArgs parses all flags", () => {
  const result = parsePackArgs([
    "--dir", "./plugins",
    "--name", "org/plugins:1.0.0",
    "-o", "./out",
    "-f", "./openmm-pack.json",
    "--annotation", "org.openmm.platform=CUDA",
    "--annotation", "org.openmm.arch=arm64",
  ])

  expect(result.dir).toBe("./plugins")
  expect(result.name).toBe("org/plugins:1.0.0")
  expect(result.output).toBe("./out")
  expect(result.file).toBe("./openmm-pack.json")
  expect(result.annotations).toEqual({
    "org.openmm.platform": "CUDA",
    "org.openmm.arch": "arm64",
  })
})

test("parsePackArgs handles missing values gracefully", () => {
  const result = parsePackArgs(["--dir"])
  expect(result.dir).toBeUndefined()
})

test("parsePackArgs ignores unknown flags", () => {
  const result = parsePackArgs(["--unknown", "--dir", "x"])
  expect(result.dir).toBe("x")
})

test("mergeOptions CLI overrides description file", () => {
  const cli = parsePackArgs(["--name", "cli:1.0", "--dir", "./cli-dir"])
  const desc = { name: "desc:2.0", dir: "./desc-dir", annotations: { a: "1" } }

  const opts = mergeOptions(cli, desc)

  expect(opts.name).toBe("cli:1.0")
  expect(opts.dir).toBe("./cli-dir")
})

test("mergeOptions annotations merge with CLI priority", () => {
  const cli = parsePackArgs(["--name", "x:1", "--annotation", "a=cli"])
  const desc = { annotations: { a: "desc", b: "desc" } }

  const opts = mergeOptions(cli, desc)

  expect(opts.annotations).toEqual({ a: "cli", b: "desc" })
})

test("mergeOptions applies defaults", () => {
  const cli = parsePackArgs(["--name", "x:1"])

  const opts = mergeOptions(cli, {})

  expect(opts.dir).toBe("./plugins")
  expect(opts.output).toBe("./oci-layout")
  expect(opts.annotations).toEqual({})
})

test("mergeOptions throws when name missing", () => {
  expect(() => mergeOptions({}, {})).toThrow("--name")
})

test("mergeOptions throws when name has no colon", () => {
  expect(() => mergeOptions({ annotations: {} }, { name: "invalid" })).toThrow("repo:tag")
})

test("loadDescriptionFile returns empty when file missing", async () => {
  const result = await loadDescriptionFile("./nonexistent-file.json")
  expect(result).toEqual({})
})

test("loadDescriptionFile parses valid JSON", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const filePath = join(tmp, "desc.json")
  await writeFile(filePath, JSON.stringify({ name: "test:1.0", dir: "./data" }))

  const result = await loadDescriptionFile(filePath)

  expect(result.name).toBe("test:1.0")
  expect(result.dir).toBe("./data")

  await rm(tmp, { recursive: true })
})

test("loadDescriptionFile throws on invalid JSON", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const filePath = join(tmp, "desc.json")
  await writeFile(filePath, "{ invalid json }")

  await expect(loadDescriptionFile(filePath)).rejects.toThrow()

  await rm(tmp, { recursive: true })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/pack.test.ts`
Expected: FAIL — `parsePackArgs`, `mergeOptions`, `loadDescriptionFile` are not exported

- [ ] **Step 3: Write minimal implementation**

Append to `src/pack.ts`:

```ts
export interface PackOptions {
  name: string
  dir: string
  output: string
  annotations: Record<string, string>
}

export interface ParsedArgs {
  dir?: string
  name?: string
  output?: string
  file?: string
  annotations: Record<string, string>
}

type DescriptionFile = Partial<PackOptions>

const SIMPLE_OPTS: Record<string, "dir" | "name" | "output" | "file"> = {
  "--dir": "dir",
  "--name": "name",
  "--output": "output",
  "-o": "output",
  "--file": "file",
  "-f": "file",
}

export function parsePackArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { annotations: {} }
  let i = 0

  while (i < args.length) {
    const arg = args[i]
    if (arg === undefined) {
      i++
      continue
    }

    const optKey = SIMPLE_OPTS[arg]
    if (optKey !== undefined) {
      const v = args[++i]
      if (v !== undefined) {
        result[optKey] = v
      }
      i++
    } else if (arg === "--annotation") {
      i = consumeAnnotation(args, i, result)
    } else {
      i++
    }
  }
  return result
}

function consumeAnnotation(args: string[], i: number, result: ParsedArgs): number {
  const v = args[i + 1]
  if (v !== undefined) {
    const eq = v.indexOf("=")
    if (eq > 0) {
      result.annotations[v.slice(0, eq)] = v.slice(eq + 1)
    }
  }
  return i + 2
}

export async function loadDescriptionFile(filePath: string): Promise<DescriptionFile> {
  try {
    const content = await readFile(filePath, "utf8")
    return JSON.parse(content) as DescriptionFile
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return {}
    }
    throw new Error(`Failed to parse description file ${filePath}: ${(e as Error).message}`)
  }
}

export function mergeOptions(cli: ParsedArgs, desc: DescriptionFile): PackOptions {
  const name = cli.name ?? desc.name
  if (name === undefined) {
    throw new Error("--name is required (provide via --name or in description file)")
  }
  if (!name.includes(":")) {
    throw new Error(`--name must be in format 'repo:tag', got: ${name}`)
  }

  return {
    name,
    dir: cli.dir ?? desc.dir ?? "./plugins",
    output: cli.output ?? "./oci-layout",
    annotations: { ...desc.annotations, ...cli.annotations },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/pack.test.ts`
Expected: PASS — all tests pass (5 prior + 11 new = 16 total)

- [ ] **Step 5: Commit**

```bash
git add src/pack.ts src/__tests__/pack.test.ts
git commit -m "feat(pack): add arg parsing, description file loading, and option merging"
```

---

### Task 6: runPack + runPackFromArgs

**Files:**
- Modify: `src/pack.ts`
- Test: `src/__tests__/pack.test.ts`

**Interfaces:**
- Consumes: `buildManifest`, `writeBlob`, `createLayerTarball`, `writeOciLayout`, `parsePackArgs`, `loadDescriptionFile`, `mergeOptions`, `PackOptions`, `CONFIG_MEDIA_TYPE`, `MANIFEST_MEDIA_TYPE` from Tasks 2-5
- Produces:
  - `runPack(options: PackOptions): Promise<void>`
  - `runPackFromArgs(args: string[]): Promise<void>`

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/pack.test.ts`:

```ts
import { runPack } from "../pack"
import { existsSync } from "node:fs"

test("runPack produces complete OCI layout from directory", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const srcDir = join(tmp, "src")
  const outputDir = join(tmp, "output")
  await mkdir(srcDir, { recursive: true })
  await writeFile(join(srcDir, "plugin.txt"), "plugin data")

  await runPack({
    name: "org/plugins:1.0.0",
    dir: srcDir,
    output: outputDir,
    annotations: { "org.openmm.platform": "CUDA" },
  })

  expect(existsSync(join(outputDir, "oci-layout"))).toBe(true)
  expect(existsSync(join(outputDir, "index.json"))).toBe(true)

  const index = JSON.parse(await readFile(join(outputDir, "index.json"), "utf8"))
  expect(index.manifests[0].annotations["org.opencontainers.image.ref.name"]).toBe(
    "org/plugins:1.0.0",
  )

  const manifestDigest = index.manifests[0].digest
  const manifestPath = join(outputDir, "blobs", "sha256", manifestDigest.slice(7))
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))

  expect(manifest.schemaVersion).toBe(2)
  expect(manifest.config.mediaType).toBe("application/vnd.oci.image.config.v1+json")
  expect(manifest.layers).toHaveLength(1)
  expect(manifest.layers[0].mediaType).toBe("application/vnd.oci.image.layer.v1.tar+gzip")
  expect(manifest.annotations).toEqual({ "org.openmm.platform": "CUDA" })

  const configPath = join(
    outputDir,
    "blobs",
    "sha256",
    manifest.config.digest.slice(7),
  )
  const config = JSON.parse(await readFile(configPath, "utf8"))
  expect(config).toEqual({})

  await rm(tmp, { recursive: true })
})

test("runPack throws when dir does not exist", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  await expect(
    runPack({ name: "x:1", dir: join(tmp, "nope"), output: join(tmp, "out"), annotations: {} }),
  ).rejects.toThrow()

  await rm(tmp, { recursive: true })
})

test("runPack throws when dir is empty", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const emptyDir = join(tmp, "empty")
  await mkdir(emptyDir, { recursive: true })

  await expect(
    runPack({ name: "x:1", dir: emptyDir, output: join(tmp, "out"), annotations: {} }),
  ).rejects.toThrow("empty")

  await rm(tmp, { recursive: true })
})

test("runPack throws when output dir exists and is not empty", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const srcDir = join(tmp, "src")
  const outputDir = join(tmp, "out")
  await mkdir(srcDir, { recursive: true })
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(srcDir, "file.txt"), "data")
  await writeFile(join(outputDir, "existing.txt"), "blocking")

  await expect(
    runPack({ name: "x:1", dir: srcDir, output: outputDir, annotations: {} }),
  ).rejects.toThrow("already exists")

  await rm(tmp, { recursive: true })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/pack.test.ts`
Expected: FAIL — `runPack` is not exported

- [ ] **Step 3: Write minimal implementation**

Append to `src/pack.ts`. Add `existsSync` and `readdir` to the `node:fs`/`node:fs/promises` imports at the top of the file.

Updated import line for `node:fs`:
```ts
import { createWriteStream, existsSync } from "node:fs"
```

Updated import line for `node:fs/promises`:
```ts
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
```

Append functions:

```ts
export async function runPack(options: PackOptions): Promise<void> {
  if (!existsSync(options.dir)) {
    throw new Error(`--dir '${options.dir}' does not exist`)
  }

  const dirStat = await stat(options.dir)
  if (!dirStat.isDirectory()) {
    throw new Error(`--dir '${options.dir}' is not a directory`)
  }

  const dirEntries = await readdir(options.dir)
  if (dirEntries.length === 0) {
    throw new Error(`--dir '${options.dir}' is empty`)
  }

  if (existsSync(options.output)) {
    const outputEntries = await readdir(options.output)
    if (outputEntries.length > 0) {
      throw new Error(`--output '${options.output}' already exists and is not empty`)
    }
  }

  const blobsDir = join(options.output, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  const layerDescriptor = await createLayerTarball(options.dir, blobsDir)

  const configDescriptor = await writeBlob(
    Buffer.from("{}"),
    blobsDir,
    CONFIG_MEDIA_TYPE,
  )

  const manifest = buildManifest(configDescriptor, layerDescriptor, options.annotations)
  const manifestBuffer = Buffer.from(JSON.stringify(manifest))
  const manifestDescriptor = await writeBlob(
    manifestBuffer,
    blobsDir,
    MANIFEST_MEDIA_TYPE,
  )

  await writeOciLayout(options.output, manifestDescriptor, options.name)

  console.log(`Packed ${options.name} → ${options.output}`)
}

export async function runPackFromArgs(args: string[]): Promise<void> {
  const cliOpts = parsePackArgs(args)

  const descFilePath = cliOpts.file ?? "./openmm-pack.json"
  const desc = await loadDescriptionFile(descFilePath)

  const options = mergeOptions(cliOpts, desc)
  await runPack(options)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/pack.test.ts`
Expected: PASS — all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/pack.ts src/__tests__/pack.test.ts
git commit -m "feat(pack): add runPack orchestrator and runPackFromArgs entry point"
```

---

### Task 7: index.ts dispatch + integration tests + QA gate

**Files:**
- Modify: `src/index.ts`
- Modify: `src/__tests__/cli.test.ts`

**Interfaces:**
- Consumes: `runPackFromArgs` from Task 6

- [ ] **Step 1: Modify index.ts for subcommand dispatch**

Current `src/index.ts` starts with shebang and `--version` check, then immediately runs the interactive demo. Add subcommand dispatch between the version check and the interactive demo.

Read the current `src/index.ts` to confirm exact content, then apply these changes:

1. Add import at the top (after existing imports):

```ts
import { runPackFromArgs } from "./pack"
```

2. After the `--version` block (line 16, after `process.exit(0)`), add subcommand dispatch before the `group(` call:

```ts
const subcommand = process.argv[2]

if (subcommand === "pack") {
  try {
    await runPackFromArgs(process.argv.slice(3))
    process.exit(0)
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    process.exit(1)
  }
}
```

The full modified file should look like:

```ts
#!/usr/bin/env node

import { readFileSync } from "node:fs"

import { cancel, group, log, select, text } from "@clack/prompts"

import { add } from "./add"
import { runPackFromArgs } from "./pack"
import { subtract } from "./subtract"

if (process.argv.includes("--version")) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string
  }
  console.log(pkg.version)
  process.exit(0)
}

const subcommand = process.argv[2]

if (subcommand === "pack") {
  try {
    await runPackFromArgs(process.argv.slice(3))
    process.exit(0)
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    process.exit(1)
  }
}

// Docs: https://github.com/bombshell-dev/clack/tree/main/packages/prompts
const results = await group(
  {
    operation: () =>
      select({
        message: `Do you want to add or subtract?`,
        options: [
          { value: "add", label: "Add" },
          { value: "subtract", label: "Subtract" },
        ],
      }),
    firstNumber: () => text({ message: "Enter the first number" }),
    secondNumber: () => text({ message: "Enter the second number" }),
  },
  {
    onCancel: () => {
      cancel("Operation cancelled.")
      process.exit(0)
    },
  },
)

log.success(
  `The answer is ${
    results.operation === "add"
      ? add(+results.firstNumber, +results.secondNumber)
      : subtract(+results.firstNumber, +results.secondNumber)
  }!`,
)
```

- [ ] **Step 2: Build to verify no type errors**

Run: `npm run typecheck && npm run build`
Expected: 无错误,dist/index.mjs 更新

- [ ] **Step 3: Write integration tests**

Append to `src/__tests__/cli.test.ts`. Merge new imports into the existing `node:fs` import line (currently `import { existsSync, readFileSync } from "node:fs"`):

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
```

Add new describe block at end of file:

```ts
describe("cli pack — integration", () => {
  it("pack creates valid OCI layout", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    const outputDir = path.join(tmp, "output")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "plugin.txt"), "test plugin content")

    try {
      const { stdout, code } = run([
        "pack",
        "--dir", fixtureDir,
        "--name", "test/fixture:1.0.0",
        "-o", outputDir,
      ])

      expect(code).toBe(0)
      expect(stdout).toContain("Packed")
      expect(existsSync(path.join(outputDir, "oci-layout"))).toBe(true)
      expect(existsSync(path.join(outputDir, "index.json"))).toBe(true)
      expect(existsSync(path.join(outputDir, "blobs", "sha256"))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("pack fails when dir does not exist", () => {
    const { stderr, code } = run([
      "pack",
      "--dir", "/nonexistent/path/xyz",
      "--name", "test:1.0",
    ])
    expect(code).toBe(1)
    expect(stderr).toContain("does not exist")
  })

  it("pack fails when name is missing", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "file.txt"), "data")

    try {
      const { stderr, code } = run(["pack", "--dir", fixtureDir])
      expect(code).toBe(1)
      expect(stderr).toContain("--name")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("pack with description file", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    const outputDir = path.join(tmp, "output")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "plugin.txt"), "from desc file")
    const descPath = path.join(tmp, "openmm-pack.json")
    writeFileSync(
      descPath,
      JSON.stringify({
        name: "desc/test:2.0.0",
        dir: fixtureDir,
        annotations: { "test.key": "test-value" },
      }),
    )

    try {
      const { stdout, code } = run([
        "pack",
        "-f", descPath,
        "-o", outputDir,
      ])

      expect(code).toBe(0)
      expect(stdout).toContain("desc/test:2.0.0")

      const index = JSON.parse(readFileSync(path.join(outputDir, "index.json"), "utf8"))
      expect(index.manifests[0].annotations["org.opencontainers.image.ref.name"]).toBe(
        "desc/test:2.0.0",
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 4: Run integration tests**

Run: `npm run build && npx vitest run src/__tests__/cli.test.ts`
Expected: PASS — 原有 1 个 + 新增 4 个 = 5 个测试通过

- [ ] **Step 5: Run full QA gate**

Run: `npm run qa`
Expected: typecheck + build + test + lint + smoke 全绿

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/__tests__/cli.test.ts
git commit -m "feat(pack): wire pack subcommand into index.ts with integration tests"
```
