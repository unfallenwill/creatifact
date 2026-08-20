import { artifactBytes, artifactExtension, fetchArtifactBytes } from "../download"

function jsonResponse(status: number, body = "x"): Response {
  return new Response(body, { status })
}

describe("artifactExtension", () => {
  it("prefers the declared mime type", () => {
    expect(artifactExtension({ url: "https://x/a.png", mimeType: "video/mp4" })).toBe("mp4")
    expect(artifactExtension({ url: "https://x/none", mimeType: "image/webp" })).toBe("webp")
  })

  it("falls back to a known url extension, stripping queries", () => {
    expect(artifactExtension({ url: "https://x/a.jpg?sig=1" })).toBe("jpg")
    expect(artifactExtension({ url: "https://x/a.jpeg#frag" })).toBe("jpg")
    expect(artifactExtension({ url: "https://x/get?id=1" })).toBe("bin")
    expect(artifactExtension({})).toBe("bin")
  })
})

describe("fetchArtifactBytes", () => {
  it("returns the body on 200", async () => {
    const fetchMock = vi.fn(async () => new Response("media-bytes", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    try {
      const bytes = await fetchArtifactBytes("https://cdn.test/a.png", { retries: 0 })
      expect(bytes.toString()).toBe("media-bytes")
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("retries transient 5xx once by default, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(502))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    try {
      const bytes = await fetchArtifactBytes("https://cdn.test/a.mp4")
      expect(bytes.toString()).toBe("ok")
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("fails fast on 4xx without retrying", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(404))
    vi.stubGlobal("fetch", fetchMock)
    try {
      await expect(fetchArtifactBytes("https://cdn.test/gone.png")).rejects.toThrow(/404/)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("retries network failures and gives up after the retry budget", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed")
    })
    vi.stubGlobal("fetch", fetchMock)
    try {
      await expect(fetchArtifactBytes("https://cdn.test/a.png")).rejects.toThrow(/fetch failed/)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("decodes data: urls locally without any network", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    try {
      const bytes = await fetchArtifactBytes("data:image/png;base64,aGk=")
      expect(bytes.toString()).toBe("hi")
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("artifactBytes", () => {
  it("decodes base64, delegates urls to the fetcher, and skips empty artifacts", async () => {
    const fetchBytes = async (url: string) => Buffer.from(`net:${url}`)
    expect((await artifactBytes({ base64: "aGk=" }, fetchBytes))?.toString()).toBe("hi")
    expect((await artifactBytes({ url: "https://cdn.test/a.png" }, fetchBytes))?.toString()).toBe(
      "net:https://cdn.test/a.png",
    )
    expect(await artifactBytes({}, fetchBytes)).toBeUndefined()
  })
})
