import { expect, test } from "vitest"
import { isLocalRef, looksLikeRegistryRef } from "../refs"

test("isLocalRef: relative, absolute, and home paths are local", () => {
  expect(isLocalRef("./oci-layout")).toBe(true)
  expect(isLocalRef("../layouts/app")).toBe(true)
  expect(isLocalRef("/tmp/oci-layout")).toBe(true)
  expect(isLocalRef("~/layouts/app")).toBe(true)
})

test("isLocalRef: registry refs and bare repos are not local", () => {
  expect(isLocalRef("localhost:5000/myrepo:1.0")).toBe(false)
  expect(isLocalRef("registry.example.com/org/app:v1")).toBe(false)
  expect(isLocalRef("myrepo:latest")).toBe(false)
})

test("looksLikeRegistryRef: host-like first segments qualify", () => {
  expect(looksLikeRegistryRef("registry.io/org/app:1.0")).toBe(true)
  expect(looksLikeRegistryRef("localhost:5000/myrepo")).toBe(true)
  expect(looksLikeRegistryRef("localhost/myrepo")).toBe(true)
})

test("looksLikeRegistryRef: tasks and bare refs do not", () => {
  expect(looksLikeRegistryRef("text2image")).toBe(false)
  expect(looksLikeRegistryRef("myrepo:latest")).toBe(false)
  // "./dir" 含 ".",单看此函数为 true;调用方(looksLikeGenRef)先经 isLocalRef 短路
})
