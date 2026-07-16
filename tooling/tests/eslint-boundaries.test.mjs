import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";

const rootDirectory = fileURLToPath(new URL("../..", import.meta.url));
const eslint = new ESLint({
  cwd: rootDirectory,
  overrideConfigFile: path.join(rootDirectory, "eslint.config.js")
});
let temporaryFileId = 0;

async function lintTemporarySource(packageDirectory, testOnly, source) {
  const fileName = `eslint-boundary-${process.pid}-${temporaryFileId++}${testOnly ? ".test.ts" : ".ts"}`;
  const filePath = path.join(rootDirectory, packageDirectory, "src", fileName);
  await writeFile(filePath, source, "utf8");

  try {
    const [result] = await eslint.lintFiles([filePath]);
    return result.messages;
  } finally {
    await rm(filePath, { force: true });
  }
}

function hasBoundaryMessage(messages, text) {
  return messages.some((message) => message.ruleId === "devspace/package-boundaries" && message.message.includes(text));
}

test("ESLint rejects deep TypeScript import types", async () => {
  const messages = await lintTemporarySource(
    "packages/domain",
    true,
    'export type Probe = typeof import("@devspace/testkit/src/index.js").withTemporaryDirectory;\n'
  );

  assert.equal(hasBoundaryMessage(messages, "deep internal imports are prohibited"), true);
});

test("ESLint rejects undeclared public testkit import types", async () => {
  const messages = await lintTemporarySource(
    "packages/security",
    true,
    'export type Probe = typeof import("@devspace/testkit").withTemporaryDirectory;\n'
  );

  assert.equal(hasBoundaryMessage(messages, "must declare @devspace/testkit as devDependencies"), true);
});

test("ESLint rejects public testkit import types from production source", async () => {
  const messages = await lintTemporarySource(
    "packages/security",
    false,
    'export type Probe = typeof import("@devspace/testkit").withTemporaryDirectory;\n'
  );

  assert.equal(hasBoundaryMessage(messages, "may be imported only from test-only files"), true);
});

test("ESLint permits a public testkit import type from a valid test file", async () => {
  const messages = await lintTemporarySource(
    "packages/domain",
    true,
    'export type Probe = typeof import("@devspace/testkit").withTemporaryDirectory;\n'
  );

  assert.deepEqual(messages.filter((message) => message.ruleId === "devspace/package-boundaries"), []);
});

test("ESLint permits a package-root self-import only from a test file", async () => {
  const messages = await lintTemporarySource(
    "packages/project-options",
    true,
    'export type Probe = typeof import("@devspace/project-options").parseProjectOptionsV1;\n'
  );

  assert.deepEqual(messages.filter((message) => message.ruleId === "devspace/package-boundaries"), []);
});

test("ESLint rejects a package-root self-import from production source", async () => {
  const messages = await lintTemporarySource(
    "packages/project-options",
    false,
    'export type Probe = typeof import("@devspace/project-options").parseProjectOptionsV1;\n'
  );

  assert.equal(hasBoundaryMessage(messages, "may not import internal package '@devspace/project-options'"), true);
});

test("ESLint keeps deep package-root self-imports forbidden", async () => {
  const messages = await lintTemporarySource(
    "packages/project-options",
    true,
    'export type Probe = typeof import("@devspace/project-options/src/index.js").parseProjectOptionsV1;\n'
  );

  assert.equal(hasBoundaryMessage(messages, "deep internal imports are prohibited"), true);
});

test("ESLint keeps normal production dependency boundaries stronger than the test exception", async () => {
  const messages = await lintTemporarySource(
    "packages/security",
    false,
    'export type Probe = typeof import("@devspace/project-options").parseProjectOptionsV1;\n'
  );

  assert.equal(hasBoundaryMessage(messages, "may not import internal package '@devspace/project-options'"), true);
});
