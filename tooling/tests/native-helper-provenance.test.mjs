import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertHelperDirectoryMatches,
  assertSupportedNativeHelperTarget,
  assertTrustedHelperBytes,
  builderProvenance,
  copyCanonicalNativeHelpers,
  helperNames,
  NATIVE_HELPER_BUILD_FLAGS,
  NATIVE_HELPER_BUILDER_IMAGE,
  NATIVE_HELPER_BUILDER_COMPILER,
  NATIVE_HELPER_BUILDER_LINKER,
  NATIVE_HELPER_CANONICAL_DIRECTORY,
  sha256File,
  sourceSha256,
  trustedHelperSha256
} from "../native-helper-provenance.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("production helper packaging does not trust ambient compiler output", () => {
  const buildSource = readFileSync(path.join(repositoryRoot, "tooling/build-staged-readback-helper.mjs"), "utf8");
  assert.doesNotMatch(buildSource, /process\.env\.CC/u);
  assert.match(buildSource, /copyCanonicalNativeHelpers/u);
});

test("canonical helper bytes match the independent trusted identities", () => {
  for (const name of helperNames()) {
    const canonicalPath = path.join(NATIVE_HELPER_CANONICAL_DIRECTORY, name);
    assert.equal(sha256File(canonicalPath), trustedHelperSha256(name));
    assert.equal(sourceSha256(name).length, 64);
  }
});

test("packaging copies canonical helpers byte-for-byte", () => {
  const outputDirectory = mkdtempSync(path.join(os.tmpdir(), "devspace-native-helper-package-"));
  try {
    copyCanonicalNativeHelpers({ outputDirectory });
    assertHelperDirectoryMatches(NATIVE_HELPER_CANONICAL_DIRECTORY, outputDirectory);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("pinned builder provenance identifies the complete build authority", () => {
  const provenance = builderProvenance();
  assert.equal(provenance.platform, "linux-x64");
  assert.match(NATIVE_HELPER_BUILDER_IMAGE, /@sha256:[a-f0-9]{64}/u);
  assert.equal(provenance.image, NATIVE_HELPER_BUILDER_IMAGE);
  assert.deepEqual(provenance.flags, NATIVE_HELPER_BUILD_FLAGS);
  assert.equal(provenance.compiler, NATIVE_HELPER_BUILDER_COMPILER);
  assert.equal(provenance.linker, NATIVE_HELPER_BUILDER_LINKER);
  for (const name of helperNames()) assert.equal(provenance.sourceSha256[name].length, 64);
});

test("rebuild comparison rejects changed helper bytes", () => {
  const firstDirectory = mkdtempSync(path.join(os.tmpdir(), "devspace-native-helper-first-"));
  const secondDirectory = mkdtempSync(path.join(os.tmpdir(), "devspace-native-helper-second-"));
  try {
    copyCanonicalNativeHelpers({ outputDirectory: firstDirectory });
    copyCanonicalNativeHelpers({ outputDirectory: secondDirectory });
    assertHelperDirectoryMatches(firstDirectory, secondDirectory);
    const changedPath = path.join(secondDirectory, helperNames()[0]);
    writeFileSync(changedPath, Buffer.from("changed helper bytes"));
    assert.throws(() => assertHelperDirectoryMatches(firstDirectory, secondDirectory), /bytes-mismatch/u);
  } finally {
    rmSync(firstDirectory, { recursive: true, force: true });
    rmSync(secondDirectory, { recursive: true, force: true });
  }
});

test("wrong and missing helpers fail closed", () => {
  assert.throws(() => assertTrustedHelperBytes(helperNames()[0], Buffer.from("wrong helper bytes")), /integrity-mismatch/u);
  const emptyDirectory = mkdtempSync(path.join(os.tmpdir(), "devspace-native-helper-missing-"));
  try {
    assert.throws(
      () => copyCanonicalNativeHelpers({ outputDirectory: path.join(emptyDirectory, "dist"), canonicalDirectory: emptyDirectory }),
      /canonical-missing/u
    );
  } finally {
    rmSync(emptyDirectory, { recursive: true, force: true });
  }
});

test("unsupported helper architectures fail closed", () => {
  assert.throws(() => assertSupportedNativeHelperTarget("linux-arm64"), /unsupported-platform/u);
});
