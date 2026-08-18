/**
 * Ref classification, shared by every consumer of image references (build
 * sources, gen package loading, the generate CLI): a ref is either a local
 * OCI layout path (relative ./… or absolute /…), a registry reference
 * (host[:port]/repo[:tag]), or bare (repo without registry — resolved
 * against the default registry by the fetch layer).
 */

export function isLocalRef(ref: string): boolean {
  return ref.startsWith(".") || ref.startsWith("/") || ref.startsWith("~")
}

/** True when the first path segment looks like a registry host, not a repo. */
export function looksLikeRegistryRef(ref: string): boolean {
  const slash = ref.indexOf("/")
  if (slash <= 0) return false
  const first = ref.slice(0, slash)
  return first.includes(".") || first.includes(":") || first === "localhost"
}
