import path from "node:path";
import { buildWithPinnedNativeHelperBuilder, helperNames } from "./native-helper-provenance.mjs";

const outputFlag = process.argv.indexOf("--output-dir");
const outputDirectory = outputFlag === -1 ? undefined : process.argv[outputFlag + 1];
if (outputDirectory === undefined || outputDirectory.length === 0) {
  throw new Error("usage: node tooling/reproduce-native-helper-artifacts.mjs --output-dir <directory>");
}

const result = await buildWithPinnedNativeHelperBuilder(path.resolve(outputDirectory));
console.log(JSON.stringify({
  ...result,
  outputDirectory: path.resolve(outputDirectory),
  helpers: Object.fromEntries(helperNames().map((name) => [name, result.helperSha256[name]]))
}, null, 2));
