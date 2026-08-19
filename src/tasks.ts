import type { Capability, ModelSupport } from "./providers"

/**
 * Task-oriented generation. Every task is an X2Y name; the task registry is
 * the single source of truth for parameters (required/optional/forbidden),
 * default-model selection, CLI usage, and the JSON request fields. CLI args,
 * `-f` JSON files, and recipe packages all normalize to one GenRequest, with
 * CLI flags taking priority.
 */

export type GenTaskName =
  | "text2text"
  | "image2text"
  | "video2text"
  | "text2image"
  | "image2image"
  | "text2video"
  | "image2video"
  | "frames2video"
  | "embed"
  | "resume"

export interface TaskSpec {
  name: GenTaskName
  /** undefined for the control command `resume`. */
  capability: Capability | undefined
  /** Produces media artifacts → result packaging applies. */
  media: boolean
  /** Field requirements; absent optional fields below are forbidden. */
  required: {
    prompt?: boolean
    images?: 1
    firstFrame?: boolean
    lastFrame?: boolean
    inputs?: boolean
    handle?: boolean
  }
  optional: {
    system?: boolean
    prompt?: boolean
    options?: boolean
    noWait?: boolean
    timeout?: boolean
    interval?: boolean
  }
  /** Positional payload after the optional provider. */
  payload: "prompt" | "inputs" | "handle"
  /** Strict default-model filter over the capability's ModelSupport. */
  pickModel?: (s: ModelSupport) => boolean
  /** Hard-fail when no model passes pickModel (frames2video). */
  strictModel?: boolean
  usage: string
}

export const TASKS: Record<GenTaskName, TaskSpec> = {
  text2text: {
    name: "text2text",
    capability: "text.generate",
    media: false,
    required: { prompt: true },
    optional: { system: true, options: true },
    payload: "prompt",
    usage: `Usage: openmmcli generate text2text [provider] [prompt] [options]

Text chat completion (text in, text out).

Arguments:
  [provider]            provider id or provider/model (e.g. zhipu/glm-4-flash);
                        omit to use the default provider
  [prompt]              the message to send (or use --prompt)

Options:
    --prompt <text>   Alternative to the positional prompt
    --system <text>   System prompt
    --opt <k=v>       Repeatable provider option (JSON-parsed when valid)
    --json            Print structured JSON to stdout
  -h, --help            Show this help message`,
  },
  image2text: {
    name: "image2text",
    capability: "image.understand",
    media: false,
    required: { inputs: true },
    optional: { prompt: true, options: true },
    payload: "prompt",
    usage: `Usage: openmmcli generate image2text [provider] [question] [options]

Ask a question about image(s) (image in, text out); with no question the
images are described.

Arguments:
  [provider]            provider id or provider/model
  [question]            optional question (or use --prompt)

Options:
    --prompt <text>   Alternative to the positional question
    --input <x>       Repeatable image (http(s)/data URL, path, pkg://path)
    --opt <k=v>       Repeatable provider option
    --json            Print structured JSON to stdout
  -h, --help            Show this help message`,
  },
  video2text: {
    name: "video2text",
    capability: "video.understand",
    media: false,
    required: { inputs: true },
    optional: { prompt: true, options: true },
    payload: "prompt",
    usage: `Usage: openmmcli generate video2text [provider] [question] [options]

Ask a question about video(s) (video in, text out); with no question the
videos are described.

Arguments:
  [provider]            provider id or provider/model
  [question]            optional question (or use --prompt)

Options:
    --prompt <text>   Alternative to the positional question
    --input <x>       Repeatable video (http(s)/data URL, path, pkg://path)
    --opt <k=v>       Repeatable provider option
    --json            Print structured JSON to stdout
  -h, --help            Show this help message`,
  },
  text2image: {
    name: "text2image",
    capability: "image.generate",
    media: true,
    required: { prompt: true },
    optional: { options: true },
    payload: "prompt",
    usage: `Usage: openmmcli generate text2image [provider] [prompt] [options]

Generate an image from text.

Arguments:
  [provider]            provider id or provider/model (e.g. zhipu/cogview-4)
  [prompt]              generation instruction (or use --prompt)

Options:
    --prompt <text>   Alternative to the positional prompt
    --opt <k=v>       Repeatable provider option
    --output <dir>    Result OCI layout directory (default ~/.openmmcli/layouts/<repo>)
    --tag <repo:tag>  Reference name for the result package
    --no-pack         Print artifacts only; do not build a result package
    --json            Print structured JSON to stdout
  -h, --help            Show this help message`,
  },
  image2image: {
    name: "image2image",
    capability: "image.generate",
    media: true,
    required: { prompt: true, images: 1 },
    optional: { options: true },
    payload: "prompt",
    pickModel: (s) => s.imageInput === true,
    usage: `Usage: openmmcli generate image2image [provider] [prompt] [options]

Generate an image from a reference image plus text (image editing /
restyling). Takes exactly one reference image.

Arguments:
  [provider]            provider id or provider/model
  [prompt]              generation instruction (or use --prompt)

Options:
    --prompt <text>   Alternative to the positional prompt
    --image <ref>     Reference image (required): http(s)/data URL, local
                      path, or pkg://path into a recipe package
    --opt <k=v>       Repeatable provider option
    --output <dir>    Result OCI layout directory (default ~/.openmmcli/layouts/<repo>)
    --tag <repo:tag>  Reference name for the result package
    --no-pack         Print artifacts only; do not build a result package
    --json            Print structured JSON to stdout
  -h, --help            Show this help message`,
  },
  text2video: {
    name: "text2video",
    capability: "video.generate",
    media: true,
    required: { prompt: true },
    optional: { options: true, noWait: true, timeout: true, interval: true },
    payload: "prompt",
    pickModel: (s) => s.textOnly !== false,
    usage: `Usage: openmmcli generate text2video [provider] [prompt] [options]

Generate a video from text (async; polls until done).

Arguments:
  [provider]            provider id or provider/model (e.g. ark/doubao-seedance-2.0)
  [prompt]              generation instruction (or use --prompt)

Options:
    --prompt <text>   Alternative to the positional prompt
    --opt <k=v>       Repeatable provider option
    --no-wait         Submit and print the task handle, then exit
    --timeout <dur>   Polling timeout (default 10m; e.g. 90s, 5m, 600)
    --interval <dur>  Polling interval (default 5s)
    --output <dir>    Result OCI layout directory (default ~/.openmmcli/layouts/<repo>)
    --tag <repo:tag>  Reference name for the result package
    --no-pack         Print artifacts only; do not build a result package
    --json            Print structured JSON to stdout
  -h, --help            Show this help message`,
  },
  image2video: {
    name: "image2video",
    capability: "video.generate",
    media: true,
    required: { prompt: true, images: 1 },
    optional: { options: true, noWait: true, timeout: true, interval: true },
    payload: "prompt",
    pickModel: (s) => s.firstFrame === true,
    usage: `Usage: openmmcli generate image2video [provider] [prompt] [options]

Generate a video from a reference image plus text; the image becomes the
video's first frame.

Arguments:
  [provider]            provider id or provider/model
  [prompt]              generation instruction (or use --prompt)

Options:
    --prompt <text>   Alternative to the positional prompt
    --image <ref>     Reference image (required): URL, local path, pkg://path
    --opt <k=v>       Repeatable provider option
    --no-wait         Submit and print the task handle, then exit
    --timeout <dur>   Polling timeout (default 10m)
    --interval <dur>  Polling interval (default 5s)
    --output <dir>    Result OCI layout directory (default ~/.openmmcli/layouts/<repo>)
    --tag <repo:tag>  Reference name for the result package
    --no-pack         Print artifacts only; do not build a result package
    --json            Print structured JSON to stdout
  -h, --help            Show this help message`,
  },
  frames2video: {
    name: "frames2video",
    capability: "video.generate",
    media: true,
    required: { prompt: true, firstFrame: true, lastFrame: true },
    optional: { options: true, noWait: true, timeout: true, interval: true },
    payload: "prompt",
    pickModel: (s) => s.firstFrame === true && s.lastFrame === true,
    strictModel: true,
    usage: `Usage: openmmcli generate frames2video [provider] [prompt] [options]

Generate a video from an explicit first frame and last frame plus text.

Arguments:
  [provider]            provider id or provider/model
                        (e.g. zhipu/viduq1-start-end)
  [prompt]              generation instruction (or use --prompt)

Options:
    --prompt <text>       Alternative to the positional prompt
    --first-frame <ref>  First frame image (required)
    --last-frame <ref>   Last frame image (required)
    --opt <k=v>          Repeatable provider option
    --no-wait            Submit and print the task handle, then exit
    --timeout <dur>      Polling timeout (default 10m)
    --interval <dur>     Polling interval (default 5s)
    --output <dir>       Result OCI layout directory (default ~/.openmmcli/layouts/<repo>)
    --tag <repo:tag>     Reference name for the result package
    --no-pack            Print artifacts only; skip the result package
    --json               Print structured JSON to stdout
  -h, --help               Show this help message`,
  },
  embed: {
    name: "embed",
    capability: "embed",
    media: false,
    required: { inputs: true },
    optional: { options: true },
    payload: "inputs",
    usage: `Usage: openmmcli generate embed [provider] [input...] [options]

Compute text embeddings (text in, vectors out).

Arguments:
  [provider]            provider id or provider/model
  [input...]            texts to embed (or use --input)

Options:
    --input <text>    Repeatable text, URL, or existing path
    --opt <k=v>       Repeatable provider option
    --json            Print structured JSON to stdout
  -h, --help            Show this help message`,
  },
  resume: {
    name: "resume",
    capability: undefined,
    media: false,
    required: { handle: true },
    optional: { timeout: true, interval: true },
    payload: "handle",
    usage: `Usage: openmmcli generate resume <handle|file> [options]

Resume polling a video task saved by a video task's --no-wait.

Arguments:
  <handle|file>         Task handle: inline JSON (starts with "{") or a file
                        path. When omitted, reads the handle from stdin.

Options:
    --timeout <dur>   Polling timeout (default 10m)
    --interval <dur>  Polling interval (default 5s)
    --output <dir>    Directory to save base64-only artifacts
    --json            Print structured JSON to stdout
  -h, --help            Show this help message`,
  },
}

/** JSON request field names a task accepts (for `-f` files and the schema). */
export function requestFieldsForTask(task: GenTaskName): Set<string> {
  const spec = TASKS[task]
  const fields = new Set<string>(["provider", "model", "json"])
  if (spec.required.prompt || spec.optional.prompt) fields.add("prompt")
  if (spec.optional.system === true) fields.add("system")
  if (spec.required.images !== undefined) fields.add("images")
  if (spec.required.firstFrame === true) fields.add("firstFrame")
  if (spec.required.lastFrame === true) fields.add("lastFrame")
  if (spec.required.inputs === true) fields.add("inputs")
  if (spec.optional.options === true) fields.add("options")
  if (spec.optional.noWait === true) fields.add("noWait")
  if (spec.optional.timeout === true) fields.add("timeout")
  if (spec.optional.interval === true) fields.add("interval")
  if (spec.media || task === "resume") fields.add("output")
  if (spec.media) {
    fields.add("tag")
    fields.add("noPack")
  }
  if (task === "resume") fields.add("handle")
  return fields
}
