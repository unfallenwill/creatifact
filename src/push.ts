export interface ParsedRef {
  registry: string
  repository: string
  tag: string
}

export function parseRef(ref: string): ParsedRef {
  let registry = "docker.io"
  let rest = ref

  const slashIdx = ref.indexOf("/")
  if (slashIdx > 0) {
    const firstPart = ref.slice(0, slashIdx)
    if (firstPart.includes(".") || firstPart.includes(":") || firstPart === "localhost") {
      registry = firstPart
      rest = ref.slice(slashIdx + 1)
    }
  }

  const colonIdx = rest.lastIndexOf(":")
  let tag = "latest"
  let repository = rest
  if (colonIdx > 0) {
    tag = rest.slice(colonIdx + 1)
    repository = rest.slice(0, colonIdx)
  }

  return { registry, repository, tag }
}
