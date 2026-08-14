export type Capability =
  | "video.generate"
  | "video.understand"
  | "image.generate"
  | "image.understand"
  | "embed"

export type FileRef = { localPath: string } | { url: string } | { base64: string }

export type ErrorCategory = "moderation" | "quota" | "rate" | "auth" | "internal"

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

type CapabilitiesToApis<Caps extends readonly Capability[]> = ("video.generate" extends Caps[number]
  ? { videoGenerate: VideoGenerateApi<unknown> }
  : unknown) &
  ("video.understand" extends Caps[number]
    ? { videoUnderstand: UnderstandApi<unknown> }
    : unknown) &
  ("image.generate" extends Caps[number] ? { imageGenerate: ImageGenerateApi<unknown> } : unknown) &
  ("image.understand" extends Caps[number]
    ? { imageUnderstand: UnderstandApi<unknown> }
    : unknown) &
  ("embed" extends Caps[number] ? { embed: EmbedApi<unknown> } : unknown)

export type Provider<Caps extends readonly Capability[] = readonly Capability[]> = {
  readonly id: string
  readonly capabilities: Caps
  readonly models: VerifiedModel[]
} & CapabilitiesToApis<Caps>

export type AnyProvider = Pick<Provider, "id" | "capabilities" | "models">

export function hasCapability<C extends Capability>(
  provider: AnyProvider,
  capability: C,
): provider is AnyProvider & CapabilitiesToApis<readonly [C]> {
  return provider.capabilities.includes(capability)
}
