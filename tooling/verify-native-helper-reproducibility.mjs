import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertHelperDirectoryMatches,
  buildWithPinnedNativeHelperBuilder,
  copyCanonicalNativeHelpers,
  helperNames,
  NATIVE_HELPER_CANONICAL_DIRECTORY,
  NATIVE_HELPER_DIST_DIRECTORY,
  sha256File
} from "./native-helper-provenance.mjs";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devspace-native-helper-repro-"));
try {
  const runOneDirectory = path.join(temporaryRoot, "run-one");
  const runTwoDirectory = path.join(temporaryRoot, "run-two");
  const runOne = await buildWithPinnedNativeHelperBuilder(runOneDirectory);
  const runTwo = await buildWithPinnedNativeHelperBuilder(runTwoDirectory);
  assertHelperDirectoryMatches(runOneDirectory, runTwoDirectory);
  assertHelperDirectoryMatches(NATIVE_HELPER_CANONICAL_DIRECTORY, runOneDirectory);
  copyCanonicalNativeHelpers({ outputDirectory: NATIVE_HELPER_DIST_DIRECTORY });
  assertHelperDirectoryMatches(NATIVE_HELPER_CANONICAL_DIRECTORY, NATIVE_HELPER_DIST_DIRECTORY);
  const hashes = Object.fromEntries(helperNames().map((name) => [name, {
    canonical: sha256File(path.join(NATIVE_HELPER_CANONICAL_DIRECTORY, name)),
    runOne: sha256File(path.join(runOneDirectory, name)),
    runTwo: sha256File(path.join(runTwoDirectory, name)),
    packaged: sha256File(path.join(NATIVE_HELPER_DIST_DIRECTORY, name))
  }]));
  console.log(JSON.stringify({ builder: runOne, repeatedBuilder: runTwo, hashes }, null, 2));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
