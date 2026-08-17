# openmmcli

A lightweight CLI tool for building, pushing, and pulling [OCI image layouts](https://github.com/opencontainers/image-spec/blob/main/image-layout.md). No Docker daemon required.

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
# 1. Build an OCI image layout from a build manifest
openmmcli package build -t org/myapp:1.0.0

# 2. Log in to a registry once (credentials are saved to the config file)
openmmcli auth login localhost:5000

# 3. Push to a registry (no more --username/--password on every call)
openmmcli package push localhost:5000/org/myapp:1.0.0

# 4. Pull from a registry
openmmcli package pull localhost:5000/org/myapp:1.0.0 -o ./pulled-layout
```

## Command forms

Every command supports two forms — a subcommand tree and a JSON request file:

```bash
# Form 1: subcommand tree
openmmcli gen image zhipu "a crane" --opt size=1024x1024
openmmcli package build -t org/myapp:1.0.0

# Form 2: JSON request file (openmmcli -f <file>.json)
openmmcli -f request.json
```

```json
{
  "$schema": "https://raw.githubusercontent.com/unfallenwill/openmmcli/main/schemas/openmm-request.schema.json",
  "command": "gen.image",
  "provider": "zhipu",
  "prompt": "a crane",
  "options": { "size": "1024x1024" },
  "output": "./artifacts"
}
```

The request file must be a JSON object with a `command` field; the remaining
fields map to that command's arguments. `command` mirrors the subcommand tree:
`gen.text` / `gen.image` / `gen.video` / `gen.understand` / `gen.embed` /
`gen.resume`, `package.build` / `package.push` / `package.pull`,
`auth.login` / `auth.logout`, `config.*`, and `models`.

## Commands

### `gen`

Generate text, images, and video via a provider model; ask questions about
media; compute embeddings. The lane is explicit; the model comes from
`<provider>` (as `provider` or `provider/model`), from the provider's default
model for that lane, or from the default provider (config key
`defaults.gen.provider`). Progress and notes go to stderr; results go to stdout.

```
Usage: openmmcli gen <lane> [provider] [args]

# text chat completion
openmmcli gen text zhipu "explain ECC memory in one paragraph"
openmmcli gen text ark/doubao-seed-1-6-250615 "hi" --system "be brief"

# image generation
openmmcli gen image zhipu "a crane" --opt size=1024x1024
openmmcli gen image zhipu/cogview-3-flash "a crane"

# video generation (polls until done; --no-wait prints the task handle)
openmmcli gen video ark "a paper crane" --no-wait
openmmcli gen video ark/doubao-seedance-2.0 "a paper crane"

# vision understanding with a local image
openmmcli gen understand ark/doubao-1.5-vision-pro-32k-250115 "what is this" --input ./cat.png

# embeddings
openmmcli gen embed ark "hello" "world"

# resume a video task saved by --no-wait
openmmcli gen resume job.json
```

With no `<provider>`, the default provider from the config is used; with no
`/model`, the provider's default model for the lane is used:

```bash
openmmcli config set defaults.gen.provider zhipu
openmmcli gen image "a crane"   # uses zhipu + its default image model
```

Lane options (run `openmmcli gen <lane> --help` for details):

| Lane | Key options |
|------|-------------|
| `text` | positional or `--prompt`, `--system`, `--opt`, `--json` |
| `image` | positional or `--prompt`, `--image <path\|url>`, `--opt`, `--output`, `--json` |
| `video` | positional or `--prompt`, `--first-frame`, `--last-frame`, `--opt`, `--no-wait`, `--timeout`, `--interval`, `--output`, `--json` |
| `understand` | positional or `--ask`, `--input` (repeatable), `--opt`, `--json` |
| `embed` | positional inputs or `--input` (repeatable), `--opt`, `--json` |
| `resume` | `<handle\|file>`, `--timeout`, `--interval`, `--output`, `--json` |

`--opt k=v` values are JSON-parsed when valid (`5` → 5, `true` → true), else
kept as strings. Credentials come from the config file (`providers.<id>.apiKey`)
or the provider's env vars (`ZHIPU_API_KEY`, `ARK_API_KEY`, ...). See
[Provider plugins](#provider-plugins) for third-party providers.

### Gen packages

`openmmcli package build` can bake a generation *recipe* (lane, provider, model,
and parameters — never API keys) into an OCI package, and `openmmcli gen <ref>`
runs it:

```jsonc
// openmm-build.json
{
  "gen": {
    "lane": "image",
    "provider": "zhipu",
    "model": "cogview-3-flash",
    "prompt": "a crane",          // optional default
    "options": { "size": "1024x1024" }
  }
}
```

```bash
# 1. Build and push the recipe package
openmmcli package build -t example.com/xxxxxx:v1.0
openmmcli package push example.com/xxxxxx:v1.0

# 2. Run it from anywhere: the lane comes from the package
openmmcli gen example.com/xxxxxx:v1.0 "a red crane" --opt size=2048x2048
openmmcli gen ./oci-layout "a crane"          # local layout also works
```

`gen <ref>` accepts a registry reference or a local OCI layout path. The
positional prompt (and `--prompt`/`--system`/`--opt`/`--image`/frame/`--input`
flags) override the package; `--opt` merges over the package options.
Credentials are resolved locally at run time.

**Image-to-image (and video frames) from package files.** Pack the reference
image into the package with the `assets` dir, then point at it with a
`pkg://path` reference:

```jsonc
// openmm-build.json
{
  "gen": {
    "lane": "image",
    "provider": "zhipu",
    "model": "cogview-3-flash",
    "image": "pkg://refs/cat.png"   // file inside the package's layers
  },
  "assets": "./assets"               // contains refs/cat.png
}
```

```bash
openmmcli package build -t example.com/img2img:v1.0
openmmcli gen example.com/img2img:v1.0 "turn it into a painting"
openmmcli gen example.com/img2img:v1.0 --image pkg://refs/dog.png   # override ref
```

Media references (`image` / `firstFrame` / `lastFrame` / `input`) accept an
http(s)/data URL, a local path, or `pkg://path` (a file in the package layers).
At `gen` time the referenced file is extracted from the package and sent to the
provider; the result package records the original `pkg://` reference for
provenance.

For image/video lanes, `gen <ref>` writes the **result as an OCI package**
(default `./oci-layout`, override with `--output`, name it with `--tag`). The
artifact becomes a layer, and the config blob records the *effective* generation
parameters plus result metadata (usage, timestamp, source ref) — so anyone can
see exactly how the image/video was produced:

```bash
openmmcli gen example.com/xxxxxx:v1.0 "a red crane" --tag org/myresult:1.0
# → ./oci-layout (index.json + blobs + a config blob with provenance)
```

Pass `--no-pack` to print artifacts without building a result package. Text/
understand/embed lanes print to stdout as usual (no artifact to package).

### `models`

```
# List available providers (built-ins + config-declared plugins)
openmmcli models

# List a provider's verified models with capability tags
openmmcli models zhipu
openmmcli models zhipu --json
```

### `package build`

Build an OCI image layout from a build manifest (`openmm-build.json` by default). The manifest describes the image *content*; everything else (tag, output dir, assets override) is passed via CLI flags.

```
Usage: openmmcli package build [options]

Options:
  -t, --tag <repo:tag>   Image reference, e.g. org/myapp:1.0.0 (required)
      --dir <path>       Local directory to pack as the top layer
                         (overrides "assets" in the manifest)
  -f, --file <path>      Build manifest path (default: ./openmm-build.json)
  -o, --output <dir>     Output OCI layout directory (default: ./oci-layout)
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

### `package push`

Push an OCI image layout to a registry.

```
Usage: openmmcli package push <registry>/<repo>:<tag> [options]

Arguments:
  <registry>/<repo>:<tag>  Destination reference (e.g. localhost:5000/myrepo:1.0)
                           If omitted, uses ref from index.json

Options:
  --layout <dir>        OCI layout directory (default: ./oci-layout)
  --username <user>     Registry username
  --password <pw>       Registry password (prefer --password-stdin)
  --password-stdin      Read password from stdin
  --plain-http          Use HTTP instead of HTTPS (for local registries)
  -h, --help            Show this help message
```

### `package pull`

Pull an OCI image layout from a registry.

```
Usage: openmmcli package pull <registry>/<repo>:<tag> [options]

Arguments:
  <registry>/<repo>:<tag>  Source reference (e.g. localhost:5000/myrepo:1.0)

Options:
  -o, --output <dir>     Output OCI layout directory (default: ./oci-layout)
  --username <user>      Registry username
  --password <pw>        Registry password (prefer --password-stdin)
  --password-stdin       Read password from stdin
  --plain-http           Use HTTP instead of HTTPS (for local registries)
  -h, --help             Show this help message
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

`package push`, `package pull`, and `package build` fall back to the saved credentials automatically
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

- `defaults.gen.provider` — provider used when `openmmcli gen <lane>` omits `<provider>`; its per-lane default model is then used.
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
