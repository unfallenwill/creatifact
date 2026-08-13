import { parseRef } from "../push"

test("parseRef parses registry with port + repo + tag", () => {
  const result = parseRef("localhost:5000/myrepo:1.0")
  expect(result).toEqual({ registry: "localhost:5000", repository: "myrepo", tag: "1.0" })
})

test("parseRef parses registry without port + nested repo", () => {
  const result = parseRef("ghcr.io/user/repo:v2")
  expect(result).toEqual({ registry: "ghcr.io", repository: "user/repo", tag: "v2" })
})

test("parseRef defaults to docker.io when no registry host", () => {
  const result = parseRef("myrepo:1.0")
  expect(result).toEqual({ registry: "docker.io", repository: "myrepo", tag: "1.0" })
})

test("parseRef defaults tag to latest when missing", () => {
  const result = parseRef("localhost:5000/myrepo")
  expect(result).toEqual({ registry: "localhost:5000", repository: "myrepo", tag: "latest" })
})

test("parseRef handles docker.io with path", () => {
  const result = parseRef("docker.io/library/nginx:1.25")
  expect(result).toEqual({ registry: "docker.io", repository: "library/nginx", tag: "1.25" })
})

test("parseRef handles localhost without port", () => {
  const result = parseRef("localhost/myrepo:tag")
  expect(result).toEqual({ registry: "localhost", repository: "myrepo", tag: "tag" })
})
