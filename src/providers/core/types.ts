export type Capability =
  | "video.generate"
  | "video.understand"
  | "image.generate"
  | "image.understand"
  | "embed"

export type FileRef = { localPath: string } | { url: string } | { base64: string }

/** Environment variable lookup (injectable for tests). */
export type Env = Record<string, string | undefined>

/**
 * - "invalid": the caller's request is malformed/unsupported (bad options,
 *   unsupported frame input) — not the provider's fault, do not retry.
 * - everything else: provider-side failure categories.
 */
export type ErrorCategory = "invalid" | "moderation" | "quota" | "rate" | "auth" | "internal"

export class ProviderError extends Error {
  readonly category: ErrorCategory
  readonly raw: unknown
  readonly status?: number | undefined

  constructor(category: ErrorCategory, message: string, raw?: unknown, status?: number) {
    super(message)
    this.name = "ProviderError"
    this.category = category
    this.raw = raw
    this.status = status
  }
}

export interface Artifact {
  url?: string | undefined
  base64?: string | undefined
  expiresAt?: string | undefined
  watermark?: boolean | undefined
  mimeType?: string | undefined
}

export interface Usage {
  native?: Record<string, unknown> | undefined
  estimatedCostUsd?: number | undefined
}

export interface JobHandle {
  readonly providerId: string
  readonly id: string
}

export type JobStatus =
  | { state: "pending" }
  | { state: "running"; progress?: number | undefined }
  | { state: "done"; artifacts: Artifact[]; usage?: Usage | undefined }
  | { state: "failed"; error: { category: ErrorCategory; raw?: unknown } }

export interface VideoGenerateApi<Opts> {
  submit(req: VideoGenerateRequest<Opts>): Promise<JobHandle>
  poll(handle: JobHandle): Promise<JobStatus>
  /** Cancel a queued task / delete a finished one, when the provider supports it. */
  cancel?(handle: JobHandle): Promise<void>
}

export interface VideoGenerateRequest<Opts> {
  model: string
  prompt: string
  firstFrame?: FileRef
  lastFrame?: FileRef
  options?: Opts
}

export interface ImageGenerateApi<Opts> {
  create(req: ImageGenerateRequest<Opts>): Promise<ImageGenerateResult>
}

export interface ImageGenerateRequest<Opts> {
  model: string
  prompt: string
  image?: FileRef
  options?: Opts
}

export interface ImageGenerateResult {
  artifacts: Artifact[]
  usage?: Usage | undefined
}

export interface UnderstandMessage {
  role: "user" | "assistant"
  content: string | Array<string | { file: FileRef; text?: string }>
}

export interface UnderstandApi<Opts> {
  create(req: UnderstandRequest<Opts>): Promise<UnderstandResult>
}

export interface UnderstandRequest<Opts> {
  model: string
  messages: UnderstandMessage[]
  options?: Opts
}

export interface UnderstandResult {
  text: string
  usage?: Usage | undefined
}

export interface EmbedApi<Opts> {
  create(req: EmbedRequest<Opts>): Promise<EmbedResult>
}

export interface EmbedRequest<Opts> {
  model: string
  inputs: string[]
  options?: Opts
}

export interface EmbedResult {
  vectors: number[][]
  dimensions?: number | undefined
  usage?: Usage | undefined
}

export interface ModelSupport {
  textOnly?: boolean
  firstFrame?: boolean
  lastFrame?: boolean
}

export interface VerifiedModel {
  id: string
  capabilities: Partial<Record<Capability, ModelSupport>>
  lastVerified: string
  note?: string
}

/**
 * A provider is identified by its id and exposes capability APIs as optional
 * methods: if `videoGenerate` is present, the provider supports video
 * generation. Capabilities are derived (see capabilitiesOf) instead of being
 * declared twice.
 */
export interface Provider {
  readonly id: string
  readonly models: VerifiedModel[]
  videoGenerate?: VideoGenerateApi<unknown>
  videoUnderstand?: UnderstandApi<unknown>
  imageGenerate?: ImageGenerateApi<unknown>
  imageUnderstand?: UnderstandApi<unknown>
  embed?: EmbedApi<unknown>
}

const METHOD_CAPABILITIES: ReadonlyArray<readonly [keyof Provider, Capability]> = [
  ["videoGenerate", "video.generate"],
  ["videoUnderstand", "video.understand"],
  ["imageGenerate", "image.generate"],
  ["imageUnderstand", "image.understand"],
  ["embed", "embed"],
]

/** Derive a provider's capabilities from which API methods it implements. */
export function capabilitiesOf(provider: Provider): Capability[] {
  const caps: Capability[] = []
  for (const [method, capability] of METHOD_CAPABILITIES) {
    if (provider[method] !== undefined) {
      caps.push(capability)
    }
  }
  return caps
}
