<script lang="ts">
import { type Entry, humanSize } from "./api"

let {
  entry,
  onopen,
  ondelete,
}: {
  entry: Entry
  onopen: (ref: string) => void
  ondelete: (ref: string) => void
} = $props()

let confirming = $state(false)
let busy = $state(false)

const created = $derived(entry.gen?.createdAt?.slice(0, 10) ?? "")
const taskLine = $derived(
  entry.gen === undefined
    ? ""
    : `${entry.gen.task}${entry.gen.model === undefined ? "" : ` · ${entry.gen.model}`}`,
)

async function confirmDelete(): Promise<void> {
  busy = true
  try {
    await ondelete(entry.ref)
  } finally {
    busy = false
    confirming = false
  }
}
</script>

<article class="card">
  <button class="cover" type="button" onclick={() => onopen(entry.ref)} title={entry.ref}>
    {#if entry.cover}
      <img src={entry.cover} alt={entry.ref} loading="lazy" />
    {:else}
      <div class="placeholder" aria-hidden="true">▣</div>
    {/if}
  </button>
  <div class="row">
    <button class="tag link" type="button" onclick={() => onopen(entry.ref)}>{entry.ref}</button>
    <span class="badge {entry.kind}">{entry.kind}</span>
    <button
      class="icon"
      type="button"
      title="Delete package"
      onclick={() => (confirming = true)}>✕</button
    >
  </div>
  {#if taskLine}<p class="task">{taskLine}</p>{/if}
  <p class="sub">
    {created}{created === "" ? "" : " · "}{humanSize(entry.size)}
  </p>

  {#if confirming}
    <div class="overlay" role="dialog" aria-modal="true">
      <p class="q">Delete “{entry.ref}”?</p>
      <p class="hint">Blobs shared with other packages survive.</p>
      <div class="row center">
        <button class="danger" type="button" disabled={busy} onclick={confirmDelete}>
          {busy ? "deleting…" : "delete"}
        </button>
        <button type="button" disabled={busy} onclick={() => (confirming = false)}>cancel</button>
      </div>
    </div>
  {/if}
</article>
