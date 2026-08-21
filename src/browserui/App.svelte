<script lang="ts">
import { Masonry } from "svelte-widgets"
import { type Detail, deletePackage, type Entry, getPackage, listPackages } from "./api"
import PackageCard from "./PackageCard.svelte"
import PackageDetail from "./PackageDetail.svelte"

let entries = $state<Entry[]>([])
let selected = $state<string | undefined>(undefined)
let detail = $state<Detail | undefined>(undefined)
let error = $state<string | undefined>(undefined)
let loading = $state(true)

async function refresh(): Promise<void> {
  loading = true
  error = undefined
  try {
    entries = await listPackages()
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    loading = false
  }
}

async function open(ref: string): Promise<void> {
  selected = ref
  detail = undefined
  try {
    detail = await getPackage(ref)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
}

async function remove(ref: string): Promise<void> {
  try {
    await deletePackage(ref)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
    return
  }
  if (selected === ref) {
    selected = undefined
    detail = undefined
  }
  await refresh()
}

function back(): void {
  selected = undefined
  detail = undefined
}

refresh()
</script>

<header>
  <h1>
    {#if selected}<button class="link" type="button" onclick={back}>← store</button> / {selected}{:else}creatifact store{/if}
  </h1>
  <p class="count">{entries.length} package{entries.length === 1 ? "" : "s"}</p>
</header>

{#if error}
  <p class="error">{error}</p>
{/if}

{#if selected !== undefined}
  {#if detail}
    <PackageDetail detail={detail} ondelete={remove} />
  {:else}
    <p class="muted">loading…</p>
  {/if}
{:else if loading}
  <p class="muted">loading…</p>
{:else if entries.length === 0}
  <p class="empty">No packages in the store yet — build, pull, or generate one first.</p>
{:else}
  <div class="masonry">
    <Masonry items={entries} gap={14} minColWidth={240} maxColWidth={420}>
      {#snippet children({ item })}
        <PackageCard entry={item} onopen={open} ondelete={remove} />
      {/snippet}
    </Masonry>
  </div>
{/if}
