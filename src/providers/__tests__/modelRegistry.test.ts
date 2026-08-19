import { describe, expect, test } from "vitest"
import { expandEnvRefs, mergeModelDeclarations } from "../core/modelRegistry"
import type { VerifiedModel } from "../core/types"

const builtin: VerifiedModel[] = [
  {
    id: "model-a",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "builtin note",
  },
  { id: "model-b", capabilities: { "image.generate": {} }, lastVerified: "2026-08" },
]

const MODES = ["v2", "t2v", "i2v", "fl2v", "s2v"] as const

describe("mergeModelDeclarations", () => {
  test("no declarations → builtin passthrough", () => {
    const merged = mergeModelDeclarations("minimax", builtin, undefined, MODES)
    expect(merged.models).toEqual(builtin)
    expect(merged.modeFor).toEqual({})
  })

  test("appends a custom video model with a valid mode", () => {
    const merged = mergeModelDeclarations(
      "minimax",
      builtin,
      [
        {
          id: "model-h4",
          mode: "v2",
          capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
          note: "new gen",
        },
      ],
      MODES,
    )
    const h4 = merged.models.find((m) => m.id === "model-h4")
    expect(h4?.source).toBe("custom")
    expect(h4?.lastVerified).toBeUndefined()
    expect(merged.modeFor["model-h4"]).toBe("v2")
    expect(merged.models).toHaveLength(3)
  })

  test("overrides a builtin entry by id (shallow merge, keeps untouched fields)", () => {
    const merged = mergeModelDeclarations(
      "minimax",
      builtin,
      [{ id: "model-a", note: "gateway overridden" }],
      MODES,
    )
    const a = merged.models.find((m) => m.id === "model-a")
    expect(a?.note).toBe("gateway overridden")
    expect(a?.capabilities["video.generate"]?.firstFrame).toBe(true)
    expect(a?.lastVerified).toBe("2026-08")
    expect(a?.source).toBeUndefined()
    // override can also retarget the protocol mode
    const retargeted = mergeModelDeclarations(
      "minimax",
      builtin,
      [{ id: "model-a", mode: "t2v" }],
      MODES,
    )
    expect(retargeted.modeFor["model-a"]).toBe("t2v")
  })

  test("custom video model without mode on a mode-table provider is rejected", () => {
    expect(() =>
      mergeModelDeclarations(
        "minimax",
        builtin,
        [{ id: "model-h4", capabilities: { "video.generate": {} } }],
        MODES,
      ),
    ).toThrow(/model-h4.*'mode' is required.*v2, t2v/)
  })

  test("unknown mode is rejected with the valid list", () => {
    expect(() =>
      mergeModelDeclarations("minimax", builtin, [{ id: "model-h4", mode: "v3" }], MODES),
    ).toThrow(/unknown mode 'v3' \(valid: v2, t2v, i2v, fl2v, s2v\)/)
  })

  test("mode on a provider without a mode table is rejected", () => {
    expect(() =>
      mergeModelDeclarations("kling", builtin, [{ id: "k4", mode: "std" }], undefined),
    ).toThrow(/k4: provider has no protocol modes; remove 'mode'/)
  })

  test("non-array / malformed entries fail loudly with the provider id", () => {
    expect(() => mergeModelDeclarations("minimax", builtin, { id: "x" }, MODES)).toThrow(
      /models config for 'minimax': must be an array/,
    )
    expect(() => mergeModelDeclarations("minimax", builtin, [{ mode: "v2" }], MODES)).toThrow(
      /\[0\]\.id must be a non-empty string/,
    )
  })
})

describe("expandEnvRefs", () => {
  const env = { MINIMAX_API_KEY: "sk-live", EMPTY: "" }
  // "$" + "{NAME}" concatenation: the literal ${} is the feature under test,
  // so avoid writing it in a plain string (biome noTemplateCurlyInString)
  const ref = (name: string): string => `$`.concat(`{${name}}`)

  test("expands whole-value refs; unresolvable refs become undefined", () => {
    expect(expandEnvRefs(ref("MINIMAX_API_KEY"), env)).toBe("sk-live")
    expect(expandEnvRefs(ref("MISSING_VAR"), env)).toBeUndefined()
    expect(expandEnvRefs(ref("EMPTY"), env)).toBeUndefined()
    expect(expandEnvRefs("", env)).toBe("")
    const prefixed = `prefix-${ref("MINIMAX_API_KEY")}`
    expect(expandEnvRefs(prefixed, env)).toBe(prefixed)
  })

  test("walks nested objects and arrays, leaves non-strings untouched", () => {
    expect(
      expandEnvRefs(
        {
          apiKey: ref("MINIMAX_API_KEY"),
          n: 5,
          b: true,
          list: [ref("MINIMAX_API_KEY"), "x", ref("MISSING")],
        },
        env,
      ),
    ).toEqual({ apiKey: "sk-live", n: 5, b: true, list: ["sk-live", "x", undefined] })
  })
})
