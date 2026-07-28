import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

if (manifest.devDependencies?.["@typescript/native"] !== "npm:typescript@7.0.2") {
  throw new Error("@typescript/native must pin the TypeScript 7 CLI compiler.");
}
if (manifest.devDependencies?.typescript !== "npm:@typescript/typescript6@^6.0.2") {
  throw new Error("typescript must remain the TypeScript 6 legacy API alias.");
}

function version(command) {
  return execFileSync("pnpm", ["exec", command, "--version"], { encoding: "utf8" }).trim();
}

if (!/^Version 7\./.test(version("tsc"))) throw new Error("tsc must resolve to TypeScript 7.");
if (!/^Version 6\./.test(version("tsc6"))) throw new Error("tsc6 must resolve to TypeScript 6.");
