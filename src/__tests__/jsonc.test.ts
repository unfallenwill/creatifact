import { stripJsonc } from "../jsonc"

test("plain JSON passes through unchanged", () => {
  const src = '{"a":1,"b":[1,2],"c":{"d":"x"}}'
  expect(stripJsonc(src)).toBe(src)
})

test("line comments outside strings are stripped, newlines preserved", () => {
  expect(stripJsonc('{\n// n\n"a":1 // t\n}')).toBe(`{\n${"    "}\n"a":1 ${"    "}\n}`)
})

test("block comments are stripped with line positions preserved", () => {
  const out = stripJsonc('{\n/* ab\ncd */"a":1\n}')
  expect(out).toBe(`{\n${"     "}\n${"     "}"a":1\n}`)
  expect(out.split("\n")).toHaveLength(4) // same line count as the input
})

test("comment markers inside string values survive", () => {
  const src = '{"prompt":"see https://example.com/a and /* not a comment */ ok"}'
  expect(stripJsonc(src)).toBe(src)
})

test("escaped quotes inside strings keep comment scanning honest", () => {
  const src = '{"prompt":"quoted \\" then // still in string"}'
  expect(stripJsonc(src)).toBe(src)
})

test("trailing commas are removed before closing brackets", () => {
  expect(stripJsonc('{"a":1,"b":[1,2,],}')).toBe('{"a":1,"b":[1,2 ] }')
})

test("trailing comma after a block comment still gets stripped", () => {
  expect(stripJsonc('{"a":1,/* c */}')).toBe(`{"a":1${" ".repeat(8)}}`)
})

test("commas inside strings survive", () => {
  const src = '{"a":"1, 2,","b":"} ]"}'
  expect(stripJsonc(src)).toBe(src)
})

test("non-trailing commas are kept", () => {
  expect(stripJsonc('{"a":[1,2]}')).toBe('{"a":[1,2]}')
})

test("unterminated string falls through for JSON.parse to report", () => {
  const out = stripJsonc('{"a":"unterminated // x')
  expect(() => JSON.parse(out)).toThrow()
})

test("jsonc manifest shape parses: comments plus trailing commas together", () => {
  const parsed = JSON.parse(
    stripJsonc(`{
      // recipe
      "assets": "./project", // top layer
      "gen": {
        "task": "text2image",
        "prompt": "a cat",
      },
    }`),
  )
  expect(parsed).toEqual({
    assets: "./project",
    gen: { task: "text2image", prompt: "a cat" },
  })
})
