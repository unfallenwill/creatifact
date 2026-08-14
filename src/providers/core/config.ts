import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ProviderCredentials {
  arkApiKey?: string
  klingApiKey?: string
  klingAccessKey?: string
  klingSecretKey?: string
  minimaxApiKey?: string
}

interface CredentialSource {
  key: keyof ProviderCredentials
  provider: string
  fileKey: string
  env: string[]
}

const CREDENTIAL_SOURCES: CredentialSource[] = [
  { key: "arkApiKey", provider: "ark", fileKey: "apiKey", env: ["ARK_API_KEY"] },
  { key: "klingApiKey", provider: "kling", fileKey: "apiKey", env: ["KLING_API_KEY"] },
  { key: "klingAccessKey", provider: "kling", fileKey: "accessKey", env: ["KLING_ACCESS_KEY"] },
  { key: "klingSecretKey", provider: "kling", fileKey: "secretKey", env: ["KLING_SECRET_KEY"] },
  { key: "minimaxApiKey", provider: "minimax", fileKey: "apiKey", env: ["MINIMAX_API_KEY"] },
]

function readConfigFile(configPath?: string): Record<string, unknown> {
  const path = configPath ?? join(homedir(), ".openmmcli", "config.json")
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function loadCredentials(
  env: Record<string, string | undefined> = process.env,
  configPath?: string,
): ProviderCredentials {
  const file = readConfigFile(configPath)
  const fileProviders = (file["providers"] ?? {}) as Record<string, Record<string, unknown>>
  const creds: ProviderCredentials = {}

  for (const source of CREDENTIAL_SOURCES) {
    const envName = source.env.find((name) => env[name] && env[name] !== "")
    if (envName && env[envName]) {
      creds[source.key] = env[envName]
      continue
    }
    const section = fileProviders[source.provider]
    const fromFile = section?.[source.fileKey]
    if (typeof fromFile === "string") {
      creds[source.key] = fromFile
    }
  }

  return creds
}
