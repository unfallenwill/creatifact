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
# 1. Build a directory into an OCI image layout
openmmcli build -t org/plugins:1.0.0 --dir ./my-plugins

# 2. Push to a registry
openmmcli push localhost:5000/org/plugins:1.0.0 --plain-http

# 3. Pull from a registry
openmmcli pull localhost:5000/org/plugins:1.0.0 -o ./pulled-layout --plain-http
```

## Commands

### `build`

Pack a local directory into an OCI image layout directory.

```
Usage: openmmcli build [options]

Options:
  -t, --tag <repo:tag>   Image reference, e.g. org/plugins:1.0.0
      --dir <path>       Directory to build (default: ./plugins)
  -f, --file <path>      Description file path (default: ./openmm-build.json)
  -o, --output <dir>     Output OCI layout directory (default: ./oci-layout)
      --annotation k=v   Add manifest annotation (repeatable)
  -h, --help             Show this help message
```

You can specify defaults in a JSON description file:

```json
{
  "tag": "org/plugins:1.0.0",
  "dir": "./my-plugins",
  "annotations": {
    "org.openmm.platform": "CUDA"
  }
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
