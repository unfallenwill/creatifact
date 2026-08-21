import { CommanderError } from "commander"

import { CliError } from "../errors"
import {
  classifyError,
  formatErrorEnvelope,
  formatResultEnvelope,
  type OutputOptions,
} from "../output"
import { JobTimeoutError, ProviderError } from "../providers"

const plain: OutputOptions = {}

test("result envelope is compact single-line JSON with stable key order", () => {
  const line = formatResultEnvelope("build", { tag: "a:1", digest: "sha256:ab" }, plain)
  expect(line).toBe('{"ok":true,"kind":"build","data":{"tag":"a:1","digest":"sha256:ab"}}')
})

test("result envelope pretty mode indents with two spaces", () => {
  const text = formatResultEnvelope("config", { path: "/tmp/x" }, { pretty: true })
  expect(text).toBe(
    [
      "{",
      '  "ok": true,',
      '  "kind": "config",',
      '  "data": {',
      '    "path": "/tmp/x"',
      "  }",
      "}",
    ].join("\n"),
  )
})

test("error envelope includes code, message, and optional details", () => {
  expect(formatErrorEnvelope("run", { code: "E_USAGE", message: "bad flag" }, plain)).toBe(
    '{"ok":false,"kind":"run","error":{"code":"E_USAGE","message":"bad flag"}}',
  )
  expect(
    formatErrorEnvelope(
      "run",
      { code: "E_PROVIDER", message: "boom", details: { category: "quota" } },
      plain,
    ),
  ).toBe(
    '{"ok":false,"kind":"run","error":{"code":"E_PROVIDER","message":"boom","details":{"category":"quota"}}}',
  )
})

test("error envelope omits kind when unknown", () => {
  expect(
    formatErrorEnvelope(undefined, { code: "E_USAGE", message: "unknown command: x" }, plain),
  ).toBe('{"ok":false,"error":{"code":"E_USAGE","message":"unknown command: x"}}')
})

test("classifyError keeps CliError classification and details", () => {
  const e = new CliError("E_CONFIG", "bad config", { key: "auths" })
  expect(classifyError(e)).toEqual({
    code: "E_CONFIG",
    message: "bad config",
    details: { key: "auths" },
  })
  expect(classifyError(new CliError("E_AUTH", "no creds"))).toEqual({
    code: "E_AUTH",
    message: "no creds",
  })
})

test("classifyError maps ProviderError with category and status", () => {
  const e = new ProviderError("rate", "slow down", { raw: 1 }, 429)
  expect(classifyError(e)).toEqual({
    code: "E_PROVIDER",
    message: "slow down",
    details: { category: "rate", status: 429 },
  })
})

test("classifyError maps job timeouts", () => {
  expect(classifyError(new JobTimeoutError("task-1"))).toEqual({
    code: "E_TIMEOUT",
    message: "job 'task-1' timed out while polling",
  })
})

test("classifyError maps commander parse failures to usage", () => {
  const e = new CommanderError(1, "commander.unknownOption", "unknown option '--nope'")
  expect(classifyError(e)).toEqual({ code: "E_USAGE", message: "unknown option '--nope'" })
})

test("classifyError recognizes fs errno codes as io errors", () => {
  const e = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })
  expect(classifyError(e)).toEqual({
    code: "E_IO",
    message: "ENOENT: no such file",
    details: { errno: "ENOENT" },
  })
})

test("classifyError recognizes fetch failures as network errors", () => {
  const direct = new TypeError("fetch failed")
  expect(classifyError(direct)).toEqual({ code: "E_NETWORK", message: "fetch failed" })

  const withCause = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ENOTFOUND" },
  })
  expect(classifyError(withCause)).toEqual({
    code: "E_NETWORK",
    message: "fetch failed",
    details: { errno: "ENOTFOUND" },
  })
})

test("classifyError falls back to internal for unknown errors", () => {
  expect(classifyError(new Error("bug"))).toEqual({ code: "E_INTERNAL", message: "bug" })
  expect(classifyError("str")).toEqual({ code: "E_INTERNAL", message: "str" })
})
