import { createHmac } from "node:crypto"

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
}

export interface JwtClaims {
  iss: string
  exp: number
  nbf: number
}

export function signKlingJwt(
  accessKey: string,
  secretKey: string,
  nowSeconds: number,
  ttlSeconds = 1800,
): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const payload = base64url(
    JSON.stringify({
      iss: accessKey,
      exp: nowSeconds + ttlSeconds,
      nbf: nowSeconds - 5,
    }),
  )
  const signature = createHmac("sha256", secretKey).update(`${header}.${payload}`).digest()
  return `${header}.${payload}.${base64url(signature)}`
}

export function decodeKlingJwtClaims(token: string): JwtClaims {
  const [, payload = ""] = token.split(".")
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as JwtClaims
}
