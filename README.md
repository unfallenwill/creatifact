# Creatifact

**An agent-native multimodal creation runtime, powered by portable OCI artifacts.**

Creatifact gives AI agents a composable CLI and JSON interface for generating,
understanding, and transforming text, images, and video across model providers.
Creation recipes, assets, results, and provenance can travel as
[OCI artifacts](https://github.com/opencontainers/image-spec/blob/main/image-layout.md)
through any OCI-compatible registry. No Docker daemon is required.

Agents handle creative planning and iteration; Creatifact handles task
execution, provider integration, artifact packaging, and delivery.

- **Agent-native** — CLI commands, JSON request files, pipelines, and structured output
- **Multimodal** — text, image, video, understanding, transformation, and embeddings
- **Portable** — move recipes and results through existing OCI registries
- **Extensible** — built-in model providers plus runtime-loaded provider plugins

## Output contract

**Every command prints exactly one JSON document to stdout** — the envelope —
regardless of terminal or pipe. Progress and warnings go to stderr; a failing
command prints its error envelope as the **last non-empty line of stderr** and
exits non-zero.

Success (compact by default):

```json
{"ok":true,"kind":"generate","data":{"task":"text2image","provider":"zhipu","model":"cogview-4","capability":"image.generate","artifacts":[{"url":"https://..."}],"usage":{},"tag":"ghcr.io/acme/crane:v1","outputDir":"...","digest":"sha256:..."}}
```

Failure:

```json
{"ok":false,"kind":"generate","error":{"code":"E_PROVIDER","message":"...","details":{"category":"quota","status":429}}}
```

- `kind` is the command: `build` · `push` · `pull` · `generate` · `login` ·
  `logout` · `models` · `config` · `package.list` · `package.rm` · `pipeline`
  (a `-f` steps file). Parse-time errors (unknown command/option) omit `kind`.
- `--pretty` (global flag) switches stdout to indented JSON, colorized on
  interactive terminals; piped `--pretty` stays byte-identical plain JSON.
- `--help` / `--version` / bare invocation stay human text (meta output).

Error codes and exit statuses:

| code | exit | meaning |
|---|---|---|
| `E_USAGE` | 2 | bad arguments, unknown command/option/task, invalid request-file fields, missing input files |
| `E_CONFIG` | 3 | config read/write/validation, unknown configured provider key |
| `E_AUTH` | 4 | missing/invalid credentials, not logged in |
| `E_NETWORK` | 5 | fetch/connection failures |
| `E_PROVIDER` | 6 | provider API errors (`details.category`/`status` when known) |
| `E_IO` | 7 | filesystem errors (`details.errno`) |
| `E_TIMEOUT` | 8 | polling timeouts (`details.handle` carries the resume handle) |
| `E_INTERNAL` | 1 | anything unclassified — a bug |

> **Breaking change (v0.1.3):** all output is JSON now; the legacy `--json`
> flags (generate tasks, `models`, request-file `json` fields) were removed.
> Scripts that parsed human text output or `--json` must switch to the envelope.

## Install

```bash
npm install -g creatifact
```

Or use directly without installing:

```bash
npx creatifact --version
```

## Quick Start

```bash
# 1. Give Creatifact a creative task
creatifact generate text2image zhipu "a paper crane in the rain" \
  --tag ghcr.io/acme/crane:v1

# 2. Publish the resulting OCI package
creatifact auth login ghcr.io
creatifact push ghcr.io/acme/crane:v1

# 3. Another agent can pull the package from the same registry
creatifact pull ghcr.io/acme/crane:v1 -o ./pulled-crane
```

Agents can invoke the same workflow through a JSON request file, making the
execution contract explicit and reproducible:

```json
{
  "$schema": "https://raw.githubusercontent.com/unfallenwill/creatifact/main/schemas/creatifact-request.schema.json",
  "command": "generate.text2image",
  "provider": "zhipu",
  "prompt": "a paper crane in the rain",
  "tag": "ghcr.io/acme/crane:v1"
}
```

```bash
creatifact -f request.json
```

## Command forms

Every command supports two forms — a subcommand tree and a JSON request file:

```bash
# Form 1: subcommand tree
creatifact generate text2image zhipu "a crane" --opt size=1024x1024
creatifact generate image2image "paint it" --model demo/my-model --image cat.png  # provider/model shorthand
creatifact build -t org/myapp:1.0.0

# Form 2: JSON request file (creatifact -f <file>.json)
creatifact -f request.json
```

```json
{
  "$schema": "https://raw.githubusercontent.com/unfallenwill/creatifact/main/schemas/creatifact-request.schema.json",
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
creatifact -f request.json --prompt "a red crane" --opt size=2048x2048
```

### Pipelines (`steps`)

A request file may instead carry a `steps` array: steps run sequentially, the
run stops at the first failure, and each step may reference earlier results
with `${name.field}` placeholders:

```json
{
  "steps": [
    { "name": "writer", "command": "generate.text2text", "provider": "zhipu",
      "prompt": "write a one-sentence image prompt about a crane" },
    { "name": "gen", "command": "generate.text2image", "provider": "zhipu",
      "prompt": "${writer.text}" },
    { "name": "edit", "command": "generate.image2image", "provider": "zhipu",
      "prompt": "make it red", "images": ["${gen.artifacts[0].url}"] },
    { "command": "push", "ref": "${gen.tag}", "layout": "${gen.outputDir}" }
  ]
}
```

Referenceable fields per command: `build` → `tag`/`digest`/`outputDir`,
`push` → `tag`/`digest`, `pull` → `outputDir`/`digest`, `generate` →
`tag`/`digest`/`outputDir` plus the structured payload when present:
`text` (text2text / image2text / video2text — chain a generated prompt into a
text2image or image2video step), `vectors`/`dimensions` (embed), and
`artifacts[N].url`/`artifacts[N].base64` (media). When a step's prompt is
exactly one earlier step's `${name.text}` reference, the result package's
config records a `gen.promptRef` provenance pointer
(`{name, digest?, tag?}` — digest present when the source step packed its
result with `tag`/`output`), so the prompt's origin is verifiable by
content-addressing instead of textual coincidence. Media inputs chained the
same way (`images` / `firstFrame` / `lastFrame` / `inputs` set to exactly
`${name.artifacts[N].url}`) additionally record `gen.inputRefs` entries
(`{field, index?, name, digest?, tag?}`): the URL that was sent to the
provider expires, but the digest still points at the source package holding
the bytes, so lineage and reproduction survive link rot. Reruns act on it:
when a provider rejects an input url, `generate <ref>` retries once with the
bytes extracted from the store via those digests (warned on stderr); without
`inputRefs` the provider error propagates unchanged. A whole
string like `"${gen.tag}"` keeps the referenced value; references inside a
larger string interpolate. `steps` and `command` are mutually exclusive; CLI
flags after the file are not supported in pipeline mode; `generate` steps may
not use `noWait`. Media steps without an explicit `output` write to the shared
store under their own tag. A pipeline run returns
`{"ok":true,"kind":"pipeline","data":{"steps":[{name?,command,kind,data}...]}}`
— every step's full result. Progress lines go to stderr.

## Commands

### `generate`

Task-oriented generation (`gen` is an alias). CLI flags, `-f` request files,
and recipe packages are equivalent; when both apply, command-line flags win.
Progress and notes go to stderr; results go to stdout.

| Task | Description | In → out | Key options |
|------|-------------|----------|-------------|
| `text2text` | Text chat | text → text | positional prompt, `--system`, `--opt` |
| `image2text` | Image understanding | image + question → text | `--input` (repeatable), optional prompt |
| `video2text` | Video understanding | video + question → text | `--input` (repeatable), optional prompt |
| `text2image` | Text-to-image | text → image | `--opt`, result packaging |
| `image2image` | Image-to-image | image + text → image | `--image` (exactly one), `--opt` |
| `text2video` | Text-to-video | text → video | `--no-wait`, `--timeout`, `--interval` |
| `image2video` | Image-to-video | image + text → video | `--image` (becomes the first frame) |
| `frames2video` | First/last-frame-to-video | first+last frame + text → video | `--first-frame`, `--last-frame` |
| `embed` | Vectorization | text → vectors | positional inputs or `--input` |
| `resume` | Resume | resume a saved video task | `<handle\|file>`, `--timeout`, `--interval` |

```
# text chat
creatifact generate text2text zhipu "explain ECC memory in one paragraph"
creatifact generate text2text ark/doubao-seed-1-6-250615 "hi" --system "be brief"
creatifact generate text2text minimax "explain the Raft consensus" --opt temperature=0.5

# text-to-image / image-to-image
creatifact generate text2image zhipu "a crane" --opt size=1024x1024
creatifact generate image2image ark "oil painting style" --image cat.png

# video: text / image / first+last frames
creatifact generate text2video ark "a paper crane" --no-wait
creatifact generate image2video kling/kling-3.0-turbo "animate" --image first.png
creatifact generate frames2video zhipu/viduq1-start-end "morph" \
  --first-frame a.png --last-frame b.png

# understanding and embeddings
creatifact generate image2text ark/doubao-1.5-vision-pro-32k-250115 "what is this" --input cat.png
creatifact generate embed ark "hello" "world"
```

With no `<provider>`, the default provider from the config is used; with no
`/model`, the task picks a default model: the provider's declared default
when it satisfies the task (e.g. `imageInput` for image2image, `firstFrame` +
`lastFrame` for frames2video), else the first verified model that does, else
a fallback with a warning (frames2video is strict and errors instead):

```bash
creatifact config set defaults.gen.provider zhipu
creatifact generate text2image "a crane"   # zhipu + its default image model
```

Wrong flag/task combinations are rejected with guidance instead of failing at
the provider:

```
$ creatifact generate text2video demo x --first-frame a.png
{"ok":false,"error":{"code":"E_USAGE","message":"text2video does not take --first-frame; use `generate image2video --image <img>`"}}
```

`--opt k=v` values are JSON-parsed when valid (`5` → 5, `true` → true), else
kept as strings. Credentials come from the config file (`providers.<id>.apiKey`)
or the provider's env vars (`ZHIPU_API_KEY`, `ARK_API_KEY`, ...). See
[Provider plugins](#provider-plugins) for third-party providers.

### Gen packages

`creatifact build` can bake a generation *recipe* (task, provider, model,
and parameters — never API keys) into an OCI package, and
`creatifact generate <ref>` runs it:

```jsonc
// creatifact-build.json
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
creatifact build -t example.com/xxxxxx:v1.0
creatifact push example.com/xxxxxx:v1.0

# 2. Run it from anywhere: the task comes from the package
creatifact generate example.com/xxxxxx:v1.0 "a red crane" --opt size=2048x2048
creatifact generate org/myresult:1.0 "a crane"  # a tag in the local store also works
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
provenance. A `prompt` that is exactly one `pkg://path` ref is read inline as
utf8 — long instructions ship as layer files (e.g. a packed `text.txt` from a
text2text result) instead of giant JSON strings.

Media tasks write their **result as an OCI package** into the shared store
under `--tag` (default `gen-output:latest`); pass `--output` to export a
standalone layout dir instead. Artifacts become a layer — URL results are
downloaded at packaging time so the package is **self-contained** (the config
blob keeps the original url for provenance; if the CDN link is already
unreachable, the build degrades to a url-only record and emits a warning
instead of losing the paid-for result). The config blob records the
*effective* generation parameters plus result metadata
(usage, timestamp, source ref) — so anyone can see exactly how the
image/video was produced:

```bash
creatifact generate example.com/xxxxxx:v1.0 "a red crane" --tag org/myresult:1.0
# → store tag org/myresult:1.0 (index.json + blobs + a config blob with provenance)
```

Pass `--no-pack` to return artifacts without building a result package.
Text and embed tasks return their payload (`data.text` / `data.vectors`) in
the envelope by default — pass `--tag` (or `--output`) to also pack it as a
referenceable OCI package: the payload becomes a layer file (`text.txt` /
`vectors.json`, usable as `pkg://` refs inside recipe packages) and the
config blob inlines `result.text` for readability. `generate ... --no-wait`
returns `data.handle`; `generate resume <handle>` returns `data.artifacts`
(+ `savedFiles` with `--output`; URL artifacts are downloaded so the files
outlive the expiring CDN link).

### `models`

```
# List available providers (built-ins + config-declared plugins);
# task-language coverage per provider, works without credentials
creatifact models

# List a provider's verified models with the tasks they support (★ = default)
creatifact models zhipu

# Discover models for one task right where you invoke it
creatifact generate image2text --list-models
creatifact generate text2video zhipu --list-models   # scoped to a provider
```

`models` always returns JSON: `creatifact models` →
`{"providers":[{provider, defaults, models:[{id, tasks, ...}]}]}` (unavailable
providers carry an `error` field); `creatifact models <id>` → the single
provider's catalog with per-model derived `tasks`. `--list-models` returns
`data.models.entries` with a `default` flag per model.

Model discovery never requires API keys (registries are static; credentials
are only consumed when a task actually runs). Model-selection errors inline
the models that DO support the task, so a failed call self-corrects.

### `build`

Build an OCI image layout from a build manifest (`creatifact-build.json` by default; `pkg` is an alias for `package`). The manifest describes the image *content*; everything else (tag, output dir, assets override) is passed via CLI flags.

```
Usage: creatifact build [options]

Options:
  -t, --tag <repo:tag>   Image reference, e.g. org/myapp:1.0.0 (required)
      --dir <path>       Local directory to pack as the top layer
                         (overrides "assets" in the manifest)
  -f, --file <path>      Build manifest path (default: ./creatifact-build.json)
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
  "$schema": "https://raw.githubusercontent.com/unfallenwill/creatifact/main/schemas/creatifact-build.schema.json",
  "annotations": {
    "org.creatifact.name": "my-package",
    "org.creatifact.description": "cuda runtime + custom assets"
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
| `gen` | object | Generation recipe (`task` required, plus `provider`, `model`, `prompt`, `system`, `options`, `images`, `firstFrame`, `lastFrame`, `inputs`). Baked into the config blob so `creatifact generate <ref>` can run it. Never includes credentials |

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
      "fileMatch": ["creatifact-build.json"],
      "url": "./schemas/creatifact-build.schema.json"
    }
  ]
}
```

### `push`

Push an OCI image layout to a registry.

```
Usage: creatifact push <registry>/<repo>:<tag> [options]

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
Usage: creatifact pull <registry>/<repo>:<tag> [options]

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

### `package ls` / `package rm`

List tags in the shared store (like `docker image ls`):

```bash
$ creatifact package ls
{"ok":true,"kind":"package.list","data":{"entries":[{"ref":"gen-output:latest","digest":"sha256:b196...","size":363,"kind":"gen"}]}}
```

`gen` marks generation result packages; `image` marks regular image layouts.

Remove tags with `package rm`; blobs shared with other tags survive, and the
last reference deletes the underlying blobs (docker rmi semantics):

```bash
$ creatifact package rm gen-output:latest
{"ok":true,"kind":"package.rm","data":{"untagged":["gen-output:latest"],"deletedBlobs":["sha256:3f2a..."]}}
```

### `auth login` / `auth logout`

Save and remove registry credentials. Credentials are stored base64-encoded in
`auths` inside the config file (the same format as `~/.docker/config.json`),
never in shell history.

```
Usage: creatifact auth login <registry> [options]

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
Usage: creatifact config <action> [args]

Actions:
  path                  Print the config file path
  list                  Print the config with secret values masked
  get <key>             Print a value (dotted key, e.g. auths.localhost:5000.username)
  set <key> <value>     Set a value (value parsed as JSON if valid, else string)
  reset                 Delete the config file
```

Each action returns its payload in the envelope: `config path` →
`data.path`, `config get` → `data.value` (secret keys come back as `"***"`
with `data.secret: true`), `config set` → `data.value`, `config reset` →
`data.removed`.

## Configuration

The config file lives at `~/.creatifact/config.json` (override with the
`CREATIFACT_CONFIG_DIR` environment variable). It is shared by all commands and
by other Creatifact modules (e.g. provider API keys under `providers`).
Built/pulled/generated images live in a **shared content store** at
`~/.creatifact/store` — one OCI layout where blobs are deduplicated by digest
and tags are pointers in `index.json` (docker-style). Rebuilding the same tag
repoints it and never touches other tags; `creatifact package ls` lists them, and
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

- `defaults.gen.provider` — provider used when `creatifact generate <task>` omits `<provider>`; the task then picks a suitable default model.
- `auths.<registry>.auth` — base64(`user:password`), docker-config-compatible; managed by `creatifact auth login`/`logout`.
- `auths.<registry>.insecure` — talk plain HTTP to this registry without `--plain-http` (per registry, not global).
- `providers.*` — passthrough section for other Creatifact modules; preserved by every write.

Credential resolution order: **CLI flags (complete pair) → config file → anonymous**.
If the config file is corrupt, commands fail loudly with the file path and a
`creatifact config reset` hint instead of silently ignoring your settings.

String values under `providers` support whole-value environment references:
`"apiKey": "${MINIMAX_API_KEY}"` resolves at call time; the file keeps the
literal, and an unset variable behaves as if the key were absent.

### Custom models

The built-in model lists are code (video APIs have no shared spec), but same-
provider new models are data: declare them under `models.<providerId>` in the
config. Unknown ids append (marked `(custom)` by `creatifact models`); known
ids override (shallow merge).

```json
{
  "models": {
    "minimax": [
      {
        "id": "MiniMax-H4",
        "mode": "v2",
        "capabilities": { "video.generate": { "textOnly": false, "firstFrame": true } },
        "note": "duration 4-15 (hint only; the provider enforces)"
      },
      { "id": "MiniMax-H3", "note": "routed via internal gateway" }
    ]
  }
}
```

Rules:

- `models` keys must name a known provider (built-in or plugin); `creatifact models` rejects unknown keys.
- Providers with protocol modes (`minimax`: `v2|t2v|i2v|fl2v|s2v`; `zhipu`:
  `cogvideox3|cogvideox|vidu-text|vidu-image|vidu-frames|vidu-reference`)
  require `mode` on custom entries declaring `video.generate`, and accept it
  on overrides to retarget the protocol.
- `kling` / `ark` pass model ids straight through; they have no modes and
  reject a `mode` field.
- Numeric constraints in `note` are hints — the provider's API is the
  authority.

### Provider plugins

Third-party providers are declared in the config under `providers.<id>.module`
and loaded at runtime via dynamic `import()`. A non-empty `module` string plus
any settings you need:

```json
{
  "providers": {
    "my-provider": { "module": "creatifact-my-provider", "apiKey": "..." }
  }
}
```

`module` accepts four specifier forms:

| Form | Example | Resolution |
|------|---------|------------|
| Bare package name | `creatifact-my-provider` | Resolved from Creatifact's own module tree first (same-project or both-global installs), then falls back to the current working directory (global CLI + project-local plugin) |
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
  when the CLI omits the model (e.g. `creatifact gen image my-provider`).

ESM (`"type": "module"`) is recommended; CommonJS (`module.exports = factory`)
is also supported. Minimal plugin:

```ts
import { createJsonClient, defineProvider, type Provider } from "creatifact/providers"

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
`pollUntil`, `ProviderError`, …) are importable from `creatifact/providers`;
add `creatifact` as a devDependency for compile-time types. No runtime
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
} from "creatifact/providers"

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
