#!/usr/bin/env node

import { readFileSync } from "node:fs"

import { cancel, group, log, select, text } from "@clack/prompts"

import { add } from "./add"
import { subtract } from "./subtract"

if (process.argv.includes("--version")) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string
  }
  console.log(pkg.version)
  process.exit(0)
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
