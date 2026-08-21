<script lang="ts">
import {
  artifacts,
  type Detail,
  type FileEntry,
  fileUrl,
  humanSize,
  isImage,
  isMedia,
  isText,
  isVideo,
  str,
  strArray,
} from "./api"

let {
  detail,
  ondelete,
}: {
  detail: Detail
  ondelete: (ref: string) => void
} = $props()

let confirming = $state(false)
let busy = $state(false)

const gen = $derived(detail.gen)
const result = $derived(detail.result)
const created = $derived(str(result, "createdAt"))
const from = $derived(str(result, "from"))
const prompt = $derived(str(gen, "prompt"))
const inputs = $derived(strArray(gen, "inputs"))
const images = $derived(strArray(gen, "images"))
const text = $derived(str(result, "text"))
const files = $derived(detail.files.filter((f) => f.type === "file"))
const mediaFiles = $derived(files.filter((f) => isMedia(f.path)))
const textFiles = $derived(files.filter((f) => isText(f.path) && !isMedia(f.path)))

let expanded = $state<Record<string, boolean>>({})

async function fetchText(f: FileEntry): Promise<void> {
  if (expanded[f.path] === true) return
  expanded[f.path] = true
  const pre = document.querySelector<HTMLElement>(`[data-text="${CSS.escape(f.path)}"]`)
  if (pre === null) return
  try {
    const res = await fetch(fileUrl(detail.ref, f.path))
    pre.textContent = res.ok ? await res.text() : `failed to load: ${res.status}`
  } catch (e) {
    pre.textContent = `failed to load: ${String(e)}`
  }
}

async function confirmDelete(): Promise<void> {
  busy = true
  try {
    await ondelete(detail.ref)
  } finally {
    busy = false
    confirming = false
  }
}
</script>

<div class="detail">
  <div class="detail-head">
    <table class="meta">
      <tbody>
        <tr><th>kind</th><td><span class="badge {detail.kind}">{detail.kind}</span></td></tr>
        <tr><th>digest</th><td class="mono">{detail.digest}</td></tr>
        <tr><th>manifest size</th><td class="mono">{humanSize(detail.size)}</td></tr>
        {#if created}<tr><th>created</th><td class="mono">{created}</td></tr>{/if}
        {#if from}<tr><th>built from</th><td class="mono">{from}</td></tr>{/if}
        {#if str(gen, "provider")}<tr><th>provider</th><td>{str(gen, "provider")}</td></tr>{/if}
        {#if str(gen, "model")}<tr><th>model</th><td>{str(gen, "model")}</td></tr>{/if}
      </tbody>
    </table>
    <button class="danger" type="button" onclick={() => (confirming = true)}>delete…</button>
    {#if confirming}
      <div class="overlay" role="dialog" aria-modal="true">
        <p class="q">Delete “{detail.ref}”?</p>
        <p class="hint">Blobs shared with other packages survive.</p>
        <div class="row center">
          <button class="danger" type="button" disabled={busy} onclick={confirmDelete}>
            {busy ? "deleting…" : "delete"}
          </button>
          <button type="button" disabled={busy} onclick={() => (confirming = false)}>cancel</button>
        </div>
      </div>
    {/if}
  </div>

  {#if prompt}
    <section>
      <h2>prompt</h2>
      <pre>{prompt}</pre>
    </section>
  {/if}

  {#if inputs && inputs.length > 0}
    <section>
      <h2>input packages</h2>
      <ul class="refs mono">{#each inputs as v}<li><code>{v}</code></li>{/each}</ul>
    </section>
  {/if}

  {#if images && images.length > 0}
    <section>
      <h2>input images</h2>
      <ul class="refs mono">{#each images as v}<li><code>{v}</code></li>{/each}</ul>
    </section>
  {/if}

  {#if artifacts(result).length > 0}
    <section>
      <h2>artifacts</h2>
      <table>
        <thead><tr><th>file</th><th>mime</th><th>source</th></tr></thead>
        <tbody>
          {#each artifacts(result) as a}
            <tr>
              <td>
                {#if a.name}<a href="{fileUrl(detail.ref, a.name)}">{a.name}</a>{:else}—{/if}
              </td>
              <td>{a.mimeType ?? ""}</td>
              <td>
                {#if a.url}<a href={a.url} rel="noopener noreferrer" target="_blank">source ↗</a>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}

  {#if text}
    <section>
      <h2>generated text</h2>
      <pre>{text}</pre>
    </section>
  {/if}

  {#if mediaFiles.length > 0}
    <section>
      <h2>media</h2>
      <div class="grid">
        {#each mediaFiles as f (f.path)}
          <figure>
            {#if isVideo(f.path)}
              <video controls preload="metadata" src={fileUrl(detail.ref, f.path)}></video>
            {:else if !isImage(f.path)}
              <audio controls preload="metadata" src={fileUrl(detail.ref, f.path)}></audio>
            {:else}
              <img loading="lazy" src={fileUrl(detail.ref, f.path)} alt={f.path} />
            {/if}
            <figcaption class="mono muted">{f.path}</figcaption>
          </figure>
        {/each}
      </div>
    </section>
  {/if}

  {#if textFiles.length > 0}
    <section>
      <h2>text files</h2>
      {#each textFiles as f (f.path)}
        <details onToggle={() => fetchText(f)}>
          <summary class="mono"
            >{f.path} <span class="muted">{humanSize(f.size ?? 0)}</span></summary
          >
          <pre data-text={f.path}></pre>
        </details>
      {/each}
    </section>
  {/if}

  <section>
    <h2>files ({detail.files.length})</h2>
    {#if detail.files.length === 0}
      <p class="empty">No files in the package layers.</p>
    {:else}
      <table>
        <thead><tr><th>path</th><th>type</th><th>size</th></tr></thead>
        <tbody>
          {#each detail.files as f (f.path)}
            <tr>
              <td class="mono">
                {#if f.type === "file"}<a href="{fileUrl(detail.ref, f.path)}">{f.path}</a
                  >{:else}{f.path}{f.type === "dir" ? "/" : ""}{/if}
              </td>
              <td>
                {f.type}{f.type === "symlink" && f.target ? ` → ${f.target}` : ""}
              </td>
              <td class="mono">{f.type === "file" ? humanSize(f.size ?? 0) : "—"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  {#if gen}
    <section>
      <details>
        <summary>full gen spec (json)</summary>
        <pre>{JSON.stringify(gen, null, 2)}</pre>
      </details>
    </section>
  {/if}
</div>
