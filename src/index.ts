#!/usr/bin/env node

import { readFileSync } from "node:fs"

import { cancel, group, log, select, text } from "@clack/prompts"

import { add } from "./add"
import { PACK_USAGE, runPackFromArgs } from "./pack"
import { PULL_USAGE, runPullFromArgs } from "./pull"
import { PUSH_USAGE, runPushFromArgs } from "./push"
import { subtract } from "./subtract"

if (process.argv.includes("--version")) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string
  }
  console.log(pkg.version)
  process.exit(0)
}

const subcommand = process.argv[2]

if (subcommand === "pack") {
  const packArgs = process.argv.slice(3)
  if (packArgs.includes("--help") || packArgs.includes("-h")) {
    console.log(PACK_USAGE)
    process.exit(0)
  }
  try {
    await runPackFromArgs(packArgs)
    process.exit(0)
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    process.exit(1)
  }
}

if (subcommand === "push") {
  const pushArgs = process.argv.slice(3)
  if (pushArgs.includes("--help") || pushArgs.includes("-h")) {
    console.log(PUSH_USAGE)
    process.exit(0)
  }
  try {
    await runPushFromArgs(pushArgs)
    process.exit(0)
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    process.exit(1)
  }
}

if (subcommand === "pull") {
  const pullArgs = process.argv.slice(3)
  if (pullArgs.includes("--help") || pullArgs.includes("-h")) {
    console.log(PULL_USAGE)
    process.exit(0)
  }
  try {
    await runPullFromArgs(pullArgs)
    process.exit(0)
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    process.exit(1)
  }
}

// Docs: https://github.com/bombshell-dev/clack/tree/main/packages/prompts
const results = await group(
  {
    operation: () =>
      select({
        message: `Do you want to add or subtract?`,
        options: [
          { value: "add", label: "Add" },
          { value: "subtract", label: "Subtract" },
        ],
      }),
    firstNumber: () => text({ message: "Enter the first number" }),
    secondNumber: () => text({ message: "Enter the second number" }),
  },
  {
    onCancel: () => {
      cancel("Operation cancelled.")
      process.exit(0)
    },
  },
)

log.success(
  `The answer is ${
    results.operation === "add"
      ? add(+results.firstNumber, +results.secondNumber)
      : subtract(+results.firstNumber, +results.secondNumber)
  }!`,
)
