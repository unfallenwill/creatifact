# openmmcli

**An agent-native multimodal creation runtime, powered by portable OCI artifacts.**

openmmcli gives AI agents a composable CLI and JSON interface for generating,
understanding, and transforming text, images, and video across model providers.
Creation recipes, assets, results, and provenance can travel as
[OCI artifacts](https://github.com/opencontainers/image-spec/blob/main/image-layout.md)
through any OCI-compatible registry. No Docker daemon is required.

Agents handle creative planning and iteration; openmmcli handles task
execution, provider integration, artifact packaging, and delivery.

- **Agent-native** — CLI commands, JSON request files, pipelines, and structured output
- **Multimodal** — text, image, video, understanding, transformation, and embeddings
- **Portable** — move recipes and results through existing OCI registries
- **Extensible** — built-in model providers plus runtime-loaded provider plugins

## Install

```bash
npm install -g openmmcli
```

Or use directly without installing:

```bash
npx openmmcli --version
```

## Quick Start

```bash
# 1. Give openmmcli a creative task
openmmcli generate text2image zhipu "a paper crane in the rain" \
  --tag ghcr.io/acme/crane:v1

# 2. Publish the resulting OCI package
openmmcli auth login ghcr.io
openmmcli push ghcr.io/acme/crane:v1

# 3. Another agent can pull the package from the same registry
openmmcli pull ghcr.io/acme/crane:v1 -o ./pulled-crane
```

Agents can invoke the same workflow through a JSON request file, making the
execution contract explicit and reproducible:

```json
{
  "$schema": "https://raw.githubusercontent.com/unfallenwill/openmmcli/main/schemas/openmm-request.schema.json",
  "command": "generate.text2image",
  "provider": "zhipu",
  "prompt": "a paper crane in the rain",
  "tag": "ghcr.io/acme/crane:v1"
}
```

```bash
openmmcli -f request.json
```

## Command forms

Every command supports two forms — a subcommand tree and a JSON request file:

```bash
# Form 1: subcommand tree
openmmcli generate text2image zhipu "a crane" --opt size=1024x1024
openmmcli generate image2image demo "paint it" --image cat.png
openmmcli build -t org/myapp:1.0.0

# Form 2: JSON request file (openmmcli -f <file>.json)
openmmcli -f request.json
```

```json
{
  "$schema": "https://raw.githubusercontent.com/unfallenwill/openmmcli/main/schemas/openmm-request.schema.json",
  "command": "generate.text2image",
  "provider": "zhipu",
  "prompt": "a crane",
  "options": { "size": "1024x1024" },
  "output": "./artifacts"
}
```

The request file must be a JSON object with a `command` field; the remaining
fields map to that command's arguments. `command` mirrors the subcommand tree:
`generate.text2text` / `generate.image2text` / `generate.video2text` /
`generate.text2image` / `generate.image2image` / `generate.text2video` /
`generate.image2video` / `generate.frames2video` / `generate.embed` /
`generate.resume`, `build` / `push` / `pull`,
`auth.login` / `auth.logout`, `config.*`, and `models`. For `generate.*`
commands, flags after the file override the file's fields (CLI wins):

```bash
openmmcli -f request.json --prompt "a red crane" --opt size=2048x2048
```

### Pipelines (`steps`)

A request file may instead carry a `steps` array: steps run sequentially, the
run stops at the first failure, and each step may reference earlier results
with `${name.field}` placeholders:

```json
{
  "steps": [
    { "name": "gen", "command": "generate.text2image", "provider": "zhipu", "prompt": "a crane" },
    { "name": "edit", "command": "generate.image2image", "provider": "zhipu",
      "prompt": "make it red", "images": ["${gen.artifacts[0].url}"] },
    { "command": "push", "ref": "${gen.tag}", "layout": "${gen.outputDir}" }
  ]
}
```

Referenceable fields per command: `build` → `tag`/`digest`/`outputDir`,
`push` → `tag`/`digest`, `pull` → `outputDir`/`digest`, `generate` →
`tag`/`digest`/`outputDir`/`artifacts[N].url`/`artifacts[N].base64`. A whole
string like `"${gen.tag}"` keeps the referenced value; references inside a
larger string interpolate. `steps` and `command` are mutually exclusive; CLI
flags after the file are not supported in pipeline mode; `generate` steps may
not use `noWait` or `json`. Media steps without an explicit `output` write to
`oci-layout-step-<n>` so they never collide inside one pipeline. Progress
lines go to stderr; each command's own output is unchanged.

## Commands

### `generate`

Task-oriented generation (`gen` is an alias). CLI flags, `-f` request files,
and recipe packages are equivalent; when both apply, command-line flags win.
Progress and notes go to stderr; results go to stdout.

| Task | 中文 | In → out | Key options |
|------|------|----------|-------------|
| `text2text` | 文本生成 | text → text | positional prompt, `--system`, `--opt` |
| `image2text` | 图生文 | image + question → text | `--input` (repeatable), optional prompt |
| `video2text` | 视频理解 | video + question → text | `--input` (repeatable), optional prompt |
| `text2image` | 文生图 | text → image | `--opt`, result packaging |
| `image2image` | 图生图 | image + text → image | `--image` (exactly one), `--opt` |
| `text2video` | 文生视频 | text → video | `--no-wait`, `--timeout`, `--interval` |
| `image2video` | 图生视频 | image + text → video | `--image` (becomes the first frame) |
| `frames2video` | 首尾帧生视频 | first+last frame + text → video | `--first-frame`, `--last-frame` |
| `embed` | 向量化 | text → vectors | positional inputs or `--input` |
| `resume` | 续跑 | resume a saved video task | `<handle\|file>`, `--timeout`, `--interval` |

```
# text chat
openmmcli generate text2text zhipu "explain ECC memory in one paragraph"
openmmcli generate text2text ark/doubao-seed-1-6-250615 "hi" --system "be brief"

# text-to-image / image-to-image
openmmcli generate text2image zhipu "a crane" --opt size=1024x1024
openmmcli generate image2image ark "oil painting style" --image cat.png

# video: text / image / first+last frames
openmmcli generate text2video ark "a paper crane" --no-wait
openmmcli generate image2video kling/kling-3.0-turbo "animate" --image first.png
openmmcli generate frames2video zhipu/viduq1-start-end "morph" \
  --first-frame a.png --last-frame b.png

# understanding and embeddings
openmmcli generate image2text ark/doubao-1.5-vision-pro-32k-250115 "what is this" --input cat.png
openmmcli generate embed ark "hello" "world"
```

With no `<provider>`, the default provider from the config is used; with no
`/model`, the task picks a default model: the provider's declared default
when it satisfies the task (e.g. `imageInput` for image2image, `firstFrame` +
`lastFrame` for frames2video), else the first verified model that does, else
a fallback with a warning (frames2video is strict and errors instead):

```bash
openmmcli config set defaults.gen.provider zhipu
openmmcli generate text2image "a crane"   # zhipu + its default image model
```

Wrong flag/task combinations are rejected with guidance instead of failing at
the provider:

```
$ openmmcli generate text2video demo x --first-frame a.png
error: text2video does not take --first-frame; use `generate image2video --image <img>`
```

`--opt k=v` values are JSON-parsed when valid (`5` → 5, `true` → true), else
kept as strings. Credentials come from the config file (`providers.<id>.apiKey`)
or the provider's env vars (`ZHIPU_API_KEY`, `ARK_API_KEY`, ...). See
[Provider plugins](#provider-plugins) for third-party providers.

### Gen packages

`openmmcli build` can bake a generation *recipe* (task, provider, model,
and parameters — never API keys) into an OCI package, and
`openmmcli generate <ref>` runs it:

```jsonc
// openmm-build.json
{
  "gen": {
    "task": "image2image",
    "provider": "zhipu",
    "model": "cogview-4",
    "prompt": "a crane",          // optional default
    "images": ["pkg://refs/cat.png"],
    "options": { "size": "1024x1024" }
  },
  "assets": "./assets"             // contains refs/cat.png
}
```

```bash
# 1. Build and push the recipe package
openmmcli build -t example.com/xxxxxx:v1.0
openmmcli push example.com/xxxxxx:v1.0

# 2. Run it from anywhere: the task comes from the package
openmmcli generate example.com/xxxxxx:v1.0 "a red crane" --opt size=2048x2048
openmmcli generate org/myresult:1.0 "a crane"  # a tag in the local store also works
```

`generate <ref>` accepts a registry reference, a tag from the local store, or a
local OCI layout path. CLI
flags (positional prompt, `--prompt`/`--opt`/`--image`/frames/`--input`,
`--provider`/`--model`) override the package: scalars override, arrays replace,
`--opt` merges per key.

Media references (`images` / `firstFrame` / `lastFrame` / `inputs`) accept an
http(s)/data URL, a local path, or a `pkg://path` into the package's layers
(packed via the `assets` dir). At generate time the file is extracted and sent
to the provider; the result package records the original `pkg://` reference for
provenance.

Media tasks write their **result as an OCI package** into the shared store
under `--tag` (default `gen-output:latest`); pass `--output` to export a
standalone layout dir instead. The artifact becomes a layer, and the config
blob records the *effective* generation parameters plus result metadata
(usage, timestamp, source ref) — so anyone can see exactly how the
image/video was produced:

```bash
openmmcli generate example.com/xxxxxx:v1.0 "a red crane" --tag org/myresult:1.0
# → store tag org/myresult:1.0 (index.json + blobs + a config blob with provenance)
```

Pass `--no-pack` to print artifacts without building a result package.
Non-media tasks (text/understand/embed) print to stdout.

### `models`

```
# List available providers (built-ins + config-declared plugins)
openmmcli models

# List a provider's verified models with capability tags
openmmcli models zhipu
openmmcli models zhipu --json
```

### `build`

Build an OCI image layout from a build manifest (`openmm-build.json` by default; `pkg` is an alias for `package`). The manifest describes the image *content*; everything else (tag, output dir, assets override) is passed via CLI flags.

```
Usage: openmmcli build [options]

Options:
  -t, --tag <repo:tag>   Image reference, e.g. org/myapp:1.0.0 (required)
      --dir <path>       Local directory to pack as the top layer
                         (overrides "assets" in the manifest)
  -f, --file <path>      Build manifest path (default: ./openmm-build.json)
  -o, --output <dir>     Export a standalone layout dir (default: shared store)
      --annotation k=v   Add manifest annotation (repeatable, overrides manifest)
      --username <user>  Registry username for from/copy sources
      --password <pw>    Registry password (prefer --password-stdin)
      --password-stdin   Read password from stdin
      --plain-http       Use HTTP for registry sources (local registries)
  -h, --help             Show this help message
```

#### Build manifest

The manifest is a plain JSON file. All fields are optional; an empty manifest builds an empty image.

```json
{
  "$schema": "https://raw.githubusercontent.com/unfallenwill/openmmcli/main/schemas/openmm-build.schema.json",
  "annotations": {
    "org.openmm.name": "my-package",
    "org.openmm.description": "cuda runtime + custom assets"
  },
  "from": [
    "localhost:5000/runtime:1.0.0",
    "localhost:5000/cuda:12.0"
  ],
  "copy": [
    { "from": "localhost:5000/cuda:12.0", "paths": ["cuda-libs", "drivers"] }
  ],
  "assets": "./app"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `annotations` | object | Manifest annotations (image metadata) |
| `from` | string \| string[] | Inherit all layers from a registry reference or a local OCI layout path. Order = layer order |
| `copy` | array | Extract specific paths from a source image into a new layer. `paths` match exact files or directory subtrees |
| `assets` | string | Local directory packed as the top layer (relative to the manifest file) |
| `gen` | object | Generation recipe (`lane` required, plus `provider`, `model`, `prompt`, `system`, `options`, `image`, `firstFrame`, `lastFrame`, `input`). Baked into the config blob so `openmmcli gen <ref>` can run it. Never includes credentials |

- `from` / `copy.from` accept a registry reference (e.g. `localhost:5000/pkg:1.0`) or a local OCI layout directory. A string starting with `.`, `/`, or an existing directory is treated as a local path.
- Relative paths in the manifest (`assets`, local `from`/`copy.from`) are resolved relative to the manifest file. CLI `--dir` is resolved relative to the current directory.
- Layers stack as: `from[0]` → `from[1]` → … → `copy[0]` → … → `assets` (top).
- Legacy fields `tag`, `dir`, `output` were removed from the manifest — pass them via CLI (`-t`, `--dir`, `-o`). The CLI prints a migration hint if it sees them.
- Copy extraction respects overlay whiteout semantics (`.wh.` deletions and `.wh..wh..opq` opaque directories) so the extracted subtree behaves exactly as it did in the source image.

#### Editor support

Reference the JSON Schema in your manifest (as in the example above), or associate it in VS Code:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["openmm-build.json"],
      "url": "./schemas/openmm-build.schema.json"
    }
  ]
}
```

### `push`

Push an OCI image layout to a registry.

```
Usage: openmmcli push <registry>/<repo>:<tag> [options]

Arguments:
  <registry>/<repo>:<tag>  Destination reference (e.g. localhost:5000/myrepo:1.0)
                           If omitted, uses ref from index.json

Options:
  --layout <dir>        OCI layout dir (default: the tag's entry in the shared store)
  --username <user>     Registry username
  --password <pw>       Registry password (prefer --password-stdin)
  --password-stdin      Read password from stdin
  --plain-http          Use HTTP instead of HTTPS (for local registries)
  -h, --help            Show this help message
```

### `pull`

Pull an OCI image layout from a registry.

```
Usage: openmmcli pull <registry>/<repo>:<tag> [options]

Arguments:
  <registry>/<repo>:<tag>  Source reference (e.g. localhost:5000/myrepo:1.0)

Options:
  -o, --output <dir>     Export a standalone layout dir (default: shared store)
  --username <user>      Registry username
  --password <pw>        Registry password (prefer --password-stdin)
  --password-stdin       Read password from stdin
  --plain-http           Use HTTP instead of HTTPS (for local registries)
  -h, --help             Show this help message
```

### `images` / `package ls` / `package rm`

List tags in the shared store (like `docker images` / `docker image ls`):

```bash
$ openmmcli images          # or: openmmcli package ls
REF                DIGEST             SIZE  KIND
gen-output:latest  b196744b7944       363B  gen
team/app-a:1       0d0e0f1a2b3c       392B  image
```

`gen` marks generation result packages; `image` marks regular image layouts.

Remove tags with `package rm`; blobs shared with other tags survive, and the
last reference deletes the underlying blobs (docker rmi semantics):

```bash
$ openmmcli package rm gen-output:latest
Untagged: gen-output:latest
Deleted: sha256:3f2a...   # only when no other tag references them
```

### `auth login` / `auth logout`

Save and remove registry credentials. Credentials are stored base64-encoded in
`auths` inside the config file (the same format as `~/.docker/config.json`),
never in shell history.

```
Usage: openmmcli auth login <registry> [options]

Arguments:
  <registry>             Registry host[:port] (e.g. localhost:5000, registry.example.com)

Options:
  -u, --username <user>  Registry username (prompted if omitted and interactive)
  -p, --password <pw>    Registry password (prefer --password-stdin)
      --password-stdin   Read password from stdin
  -h, --help             Show this help message
```

`push`, `pull`, and `build` fall back to the saved credentials automatically
when `--username`/`--password` are not passed. A complete CLI credential pair
always wins over the config file.

### `config`

```
Usage: openmmcli config <action> [args]

Actions:
  path                  Print the config file path
  list                  Print the config with secret values masked
  get <key>             Print a value (dotted key, e.g. auths.localhost:5000.username)
  set <key> <value>     Set a value (value parsed as JSON if valid, else string)
  reset                 Delete the config file
```

## Configuration

The config file lives at `~/.openmmcli/config.json` (override with the
`OPENMMCLI_CONFIG_DIR` environment variable). It is shared by all commands and
by other openmmcli modules (e.g. provider API keys under `providers`).
Built/pulled/generated images live in a **shared content store** at
`~/.openmmcli/store` — one OCI layout where blobs are deduplicated by digest
and tags are pointers in `index.json` (docker-style). Rebuilding the same tag
repoints it and never touches other tags; `openmmcli images` lists them, and
`--output`/`--layout` still pin/export an explicit standalone directory.
A per-invocation override is also available: pass `--config-dir <dir>` to any
subcommand to use `<dir>/config.json` (takes precedence over the env var).

```json
{
  "defaults": {
    "gen": { "provider": "zhipu" }
  },
  "auths": {
    "localhost:5000": {
      "auth": "dXNlcjpwYXNz",
      "insecure": true
    }
  },
  "providers": {
    "ark": { "apiKey": "..." }
  }
}
```

- `defaults.gen.provider` — provider used when `openmmcli generate <task>` omits `<provider>`; the task then picks a suitable default model.
- `auths.<registry>.auth` — base64(`user:password`), docker-config-compatible; managed by `openmmcli auth login`/`logout`.
- `auths.<registry>.insecure` — talk plain HTTP to this registry without `--plain-http` (per registry, not global).
- `providers.*` — passthrough section for other openmmcli modules; preserved by every write.

Credential resolution order: **CLI flags (complete pair) → config file → anonymous**.
If the config file is corrupt, commands fail loudly with the file path and a
`openmmcli config reset` hint instead of silently ignoring your settings.

### Provider plugins

Third-party providers are declared in the config under `providers.<id>.module`
and loaded at runtime via dynamic `import()`. A non-empty `module` string plus
any settings you need:

```json
{
  "providers": {
    "my-provider": { "module": "openmmcli-my-provider", "apiKey": "..." }
  }
}
```

`module` accepts four specifier forms:

| Form | Example | Resolution |
|------|---------|------------|
| Bare package name | `openmmcli-my-provider` | Resolved from openmmcli's own module tree first (same-project or both-global installs), then falls back to the current working directory (global CLI + project-local plugin) |
| Relative path | `./plugins/my-provider.mjs` | Resolved against the caller's `cwd` |
| Absolute path | `/opt/plugins/my-provider.mjs` | Used as-is |
| Home path | `~/plugins/my-provider.mjs` | `~` expanded via the home directory |

A plugin module must default-export a `(settings, env) => Provider` factory.
`module` itself is stripped before the factory is called, so the factory only
sees its business settings. The returned provider must:

- declare a non-empty `id` **equal to** the config section key,
- expose `models` as an array whose entries each have a non-empty `id`,
- implement at least one capability API (`textGenerate`, `videoGenerate`,
  `videoUnderstand`, `imageGenerate`, `imageUnderstand`, `embed`),
- optionally declare `defaultModels` — a `{ capability: modelId }` map used
  when the CLI omits the model (e.g. `openmmcli gen image my-provider`).

ESM (`"type": "module"`) is recommended; CommonJS (`module.exports = factory`)
is also supported. Minimal plugin:

```ts
import { createJsonClient, defineProvider, type Provider } from "openmmcli/providers"

interface Settings {
  apiKey?: string
}

export default defineProvider((settings: Settings, env) => {
  const apiKey = settings.apiKey ?? env["MY_PROVIDER_API_KEY"]
  if (!apiKey) throw new Error("missing API key: set MY_PROVIDER_API_KEY or providers.my-provider.apiKey")
  const client = createJsonClient({ baseUrl: "https://api.example.com", headers: { authorization: `Bearer ${apiKey}` } })
  const provider: Provider = {
    id: "my-provider",
    models: [{ id: "my-model", capabilities: { "image.generate": "supported" }, lastVerified: "2026-08" }],
    defaultModels: { "image.generate": "my-model" },
    imageGenerate: {
      async create(req) {
        const res = await client.requestJson("/v1/images", { method: "POST", body: req })
        return { images: [{ url: res["url"] as string }] }
      },
    },
  }
  return provider
})
```

Types and helpers (`Provider`, `defineProvider`, `createJsonClient`,
`pollUntil`, `ProviderError`, …) are importable from `openmmcli/providers`;
add `openmmcli` as a devDependency for compile-time types. No runtime
peerDependency is required.

Load failures (module not found, bad export shape, `id` mismatch, no capability
APIs) throw a `PluginError` with the provider id — they are configuration or
programming errors and are never retried. `module` cannot be set on built-in
provider ids (`ark`, `kling`, `minimax`, `zhipu`).

Programmatic use:

```ts
import {
  createProvider,
  listConfiguredProviderIds,
  listProviderIds,
} from "openmmcli/providers"

const provider = await createProvider("my-provider") // async since plugins load via import()
listProviderIds()            // built-ins only, sync
listConfiguredProviderIds()  // built-ins + config-declared plugins, sync
```

## Development

```bash
npm run dev          # Run directly via tsx
npm run typecheck    # TypeScript type checking
npm run build        # Build to dist/
npm test             # Run tests
npm run qa           # Full gate: typecheck + build + test + lint + smoke
```

## License

[MIT](LICENSE)
