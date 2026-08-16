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
openmmcli build -t org/myapp:1.0.0

# 2. Log in to a registry once (credentials are saved to the config file)
openmmcli login localhost:5000

# 3. Push to a registry (no more --username/--password on every call)
openmmcli push localhost:5000/org/myapp:1.0.0

# 4. Pull from a registry
openmmcli pull localhost:5000/org/myapp:1.0.0 -o ./pulled-layout
```

## Commands

### `build`

Build an OCI image layout from a build manifest (`openmm-build.json` by default). The manifest describes the image *content*; everything else (tag, output dir, assets override) is passed via CLI flags.

```
Usage: openmmcli build [options]

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
  --layout <dir>        OCI layout directory (default: ./oci-layout)
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
  -o, --output <dir>     Output OCI layout directory (default: ./oci-layout)
  --username <user>      Registry username
  --password <pw>        Registry password (prefer --password-stdin)
  --password-stdin       Read password from stdin
  --plain-http           Use HTTP instead of HTTPS (for local registries)
  -h, --help             Show this help message
```

### `login` / `logout`

Save and remove registry credentials. Credentials are stored base64-encoded in
`auths` inside the config file (the same format as `~/.docker/config.json`),
never in shell history.

```
Usage: openmmcli login <registry> [options]

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

### `gen`

Generate media via a provider model. One entry point for all lanes — image/video
generation, understanding, embeddings — derived from the model's capabilities
and your trigger flags: `--prompt` drives generation, `--ask` drives
understanding, `--input` (repeatable) drives embeddings or message attachments.
Progress and notes go to stderr; results go to stdout.

```
Usage: openmmcli gen <provider>/<model> [options]

# image generation
openmmcli gen zhipu/cogview-3-flash --prompt "a crane" --opt size=1024x1024

# video generation (polls until done; --no-wait prints the task handle)
openmmcli gen zhipu/cogvideox-flash --prompt "a paper crane" --no-wait

# vision understanding with a local image
openmmcli gen ark/doubao-1.5-vision-pro-32k-250115 --image ./cat.png --ask "what is this"

# embeddings
openmmcli gen ark/doubao-embedding-large-text-240915 --input "hello" --input ./note.txt

Options:
  --prompt <text>          Generation instruction
  --ask <text>             Question for understanding models (mutually exclusive with --prompt)
  --input <text|path|url>  Repeatable. Embedding inputs or attachments (URL or existing path = file)
      --first-frame <path|url>  Video first frame
      --last-frame <path|url>   Video last frame
      --image <path|url>        Reference image for image generation
      --opt <k=v>          Repeatable provider option; value JSON-parsed when valid (5 → 5, true → true)
      --no-wait           Video only: print the task handle and exit
      --timeout <dur>     Polling timeout (default 10m; e.g. 90s, 5m, 600)
      --interval <dur>    Polling interval (default 5s)
      --output <dir>      Directory to save base64-only artifacts
      --json              Structured JSON output
```

Credentials come from the config file (`providers.<id>.apiKey`) or the
provider's env vars (`ZHIPU_API_KEY`, `ARK_API_KEY`, ...). See
[Provider plugins](#provider-plugins) for third-party providers.

### `models`

```
# List available providers (built-ins + config-declared plugins)
openmmcli models

# List a provider's verified models with capability tags
openmmcli models zhipu
openmmcli models zhipu --json
```

### `jobs`

Resume polling a video task saved by `gen --no-wait`:

```
openmmcli jobs job.json                  # handle file
openmmcli jobs '{"providerId":"zhipu","id":"..."}'   # inline
cat job.json | openmmcli jobs            # stdin
```

## Configuration

The config file lives at `~/.openmmcli/config.json` (override with the
`OPENMMCLI_CONFIG_DIR` environment variable). It is shared by all commands and
by other openmmcli modules (e.g. provider API keys under `providers`).
A per-invocation override is also available: pass `--config-dir <dir>` to any
subcommand to use `<dir>/config.json` (takes precedence over the env var).

```json
{
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

- `auths.<registry>.auth` — base64(`user:password`), docker-config-compatible; managed by `openmmcli login`/`logout`.
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
- implement at least one capability API (`videoGenerate`, `videoUnderstand`,
  `imageGenerate`, `imageUnderstand`, `embed`).

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
