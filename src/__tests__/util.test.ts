import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureOutputDirEmpty, readPasswordFromStdin } from "../util"

test("ensureOutputDirEmpty accepts missing and empty dirs", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "util-test-"))
  await expect(ensureOutputDirEmpty(join(tmp, "missing"))).resolves.toBeUndefined()

  const emptyDir = join(tmp, "empty")
  await mkdir(emptyDir, { recursive: true })
  await expect(ensureOutputDirEmpty(emptyDir)).resolves.toBeUndefined()

  await rm(tmp, { recursive: true })
})

test("ensureOutputDirEmpty throws for non-empty dir", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "util-test-"))
  const dir = join(tmp, "out")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "blocking.txt"), "x")

  await expect(ensureOutputDirEmpty(dir)).rejects.toThrow("already exists")

  await rm(tmp, { recursive: true })
})

test("readPasswordFromStdin reads trimmed password from stdin", async () => {
  const stdin = new EventEmitter() as NodeJS.ReadStream
  const originalStdin = process.stdin
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true })

  const promise = readPasswordFromStdin()
  stdin.emit("data", Buffer.from("secret-password\n"))
  stdin.emit("end")

  await expect(promise).resolves.toBe("secret-password")

  Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true })
})

test("readPasswordFromStdin resolves undefined on empty input", async () => {
  const stdin = new EventEmitter() as NodeJS.ReadStream
  const originalStdin = process.stdin
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true })

  const promise = readPasswordFromStdin()
  stdin.emit("data", Buffer.from("   \n"))
  stdin.emit("end")

  await expect(promise).resolves.toBeUndefined()

  Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true })
})
