import { buildManifest, type OCIDescriptor } from "../pack"

test("buildManifest produces valid OCI manifest with annotations", () => {
  const config: OCIDescriptor = {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest: "sha256:abc",
    size: 2,
  }
  const layer: OCIDescriptor = {
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    digest: "sha256:def",
    size: 100,
  }
  const annotations = { "org.openmm.platform": "CUDA" }

  const manifest = buildManifest(config, layer, annotations)

  expect(manifest.schemaVersion).toBe(2)
  expect(manifest.mediaType).toBe("application/vnd.oci.image.manifest.v1+json")
  expect(manifest.config).toEqual(config)
  expect(manifest.layers).toEqual([layer])
  expect(manifest.annotations).toEqual(annotations)
})

test("buildManifest omits annotations when empty", () => {
  const config: OCIDescriptor = {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest: "sha256:abc",
    size: 2,
  }
  const layer: OCIDescriptor = {
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    digest: "sha256:def",
    size: 100,
  }

  const manifest = buildManifest(config, layer, {})

  expect(manifest.annotations).toBeUndefined()
})
