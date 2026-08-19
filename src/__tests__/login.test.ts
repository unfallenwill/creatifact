import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { encodeAuth } from "../config"
import { parseLoginArgs, runLogin, runLoginFromArgs, runLogout, runLogoutFromArgs } from "../login"

function tmpConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "creatifact-login-")), "config.json")
}

function readConfig(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

test("parseLoginArgs parses registry, flags and positionals", () => {
  const parsed = parseLoginArgs(["localhost:5000", "-u", "user", "--password-stdin"])
  expect(parsed.registry).toBe("localhost:5000")
  expect(parsed.username).toBe("user")
  expect(parsed.passwordStdin).toBe(true)
  expect(parsed.password).toBeUndefined()
})

test("runLogin writes docker-compatible auths entry", async () => {
  const path = tmpConfigPath()

  await runLogin("https://LocalHost:5000/", "user", "pw", { configPath: path })

  const config = readConfig(path)
  const auths = config["auths"] as Record<string, { auth: string; username: string }>
  expect(auths["localhost:5000"]).toEqual({
    auth: encodeAuth("user", "pw"),
    username: "user",
  })
})

test("runLogin preserves providers section and existing insecure flag", async () => {
  const path = tmpConfigPath()
  writeFileSync(
    path,
    JSON.stringify({
      providers: { ark: { apiKey: "k" } },
      auths: { "localhost:5000": { insecure: true } },
    }),
  )

  await runLogin("localhost:5000", "user", "pw", { configPath: path })

  const config = readConfig(path)
  expect(config["providers"]).toEqual({ ark: { apiKey: "k" } })
  const entry = (config["auths"] as Record<string, Record<string, unknown>>)["localhost:5000"]
  expect(entry?.["insecure"]).toBe(true)
  expect(entry?.["auth"]).toBe(encodeAuth("user", "pw"))
})

test("runLogin rejects refs that are not registry hosts", async () => {
  const path = tmpConfigPath()
  await expect(runLogin("localhost:5000/repo:1.0", "u", "p", { configPath: path })).rejects.toThrow(
    /not a registry host/,
  )
})

test("runLoginFromArgs with explicit flags works non-interactively", async () => {
  const path = tmpConfigPath()
  await runLoginFromArgs(["reg.example.com", "-u", "ci", "--password", "secret"], {
    configPath: path,
  })

  const config = readConfig(path)
  const auths = config["auths"] as Record<string, { auth: string }>
  expect(auths["reg.example.com"]?.auth).toBe(encodeAuth("ci", "secret"))
})

test("runLoginFromArgs requires a registry argument", async () => {
  await expect(runLoginFromArgs(["-u", "x", "--password", "y"])).rejects.toThrow(/registry/)
})

test("runLogout removes credentials but keeps the insecure flag", async () => {
  const path = tmpConfigPath()
  await runLogin("reg.io", "u", "p", { configPath: path })
  await runLogin("other.io", "u2", "p2", { configPath: path })
  const before = readConfig(path)
  ;(before["auths"] as Record<string, unknown>)["reg.io"] = {
    auth: "dXpw",
    username: "u",
    insecure: true,
  }
  writeFileSync(path, JSON.stringify(before))

  const removed = await runLogout("reg.io", { configPath: path })
  expect(removed).toBe(true)

  const config = readConfig(path)
  const auths = config["auths"] as Record<string, { insecure?: boolean; auth?: string }>
  expect(auths["reg.io"]).toEqual({ insecure: true })
  expect(auths["other.io"]).toBeDefined()
})

test("runLogout returns false when not logged in", async () => {
  const path = tmpConfigPath()
  expect(await runLogout("reg.io", { configPath: path })).toBe(false)
})

test("runLogoutFromArgs errors when not logged in", async () => {
  const path = tmpConfigPath()
  await expect(runLogoutFromArgs(["reg.io"], { configPath: path })).rejects.toThrow(/Not logged in/)
})
