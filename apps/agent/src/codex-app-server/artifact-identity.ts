import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  type CodexArtifactLayout,
  type CodexCompatibilityDiagnostic
} from "@devspace/contracts";
import {
  durableJsonWriter,
  identitiesEqual,
  lstatIdentity,
  readRegularFileNoFollow,
  type FileIdentity
} from "../private-state.js";

const MAX_CLOSURE_ENTRIES = 4_096;
const MAX_CLOSURE_BYTES = 1_024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_DIRECTORY_DEPTH = 64;
const MAX_PACKAGE_ANCESTORS = 16;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

const standaloneTopLevelNames = new Set(["bin", "codex", "codex-package.json", "codex-path", "codex-resources"]);

export interface CodexArtifactEntry {
  readonly relativePath: string;
  readonly kind: "file" | "symlink";
  readonly mode: number;
  readonly linkTarget: string | null;
  readonly byteLength: number;
  readonly sha256: string | null;
}

export interface CodexExecutionArtifact {
  readonly configuredPath: string;
  readonly canonicalSourceRoot: string;
  readonly layout: CodexArtifactLayout;
  readonly target: { readonly os: string; readonly architecture: string; readonly abi: string };
  readonly packageVersion: string | null;
  readonly entrypoint: CodexArtifactEntry;
  readonly entries: readonly CodexArtifactEntry[];
  readonly entrypointSha256: string;
  readonly closureDigest: string;
}

export interface StagedCodexExecutionArtifact {
  readonly artifact: CodexExecutionArtifact;
  readonly stagingRoot: string;
  readonly entrypointPath: string;
  readonly readbackManifestPath: string;
  readonly cacheState: "hit" | "miss" | "repaired";
}

export class CodexArtifactIdentityError extends Error {
  constructor(readonly diagnostic: CodexCompatibilityDiagnostic) {
    super(diagnostic);
    this.name = "CodexArtifactIdentityError";
  }
}

function artifactError(diagnostic: CodexCompatibilityDiagnostic): CodexArtifactIdentityError {
  return new CodexArtifactIdentityError(diagnostic);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("artifact-canonical-json-unsupported");
}

export function codexExecutionArtifactClosureDigest(input: {
  readonly layout: CodexArtifactLayout;
  readonly target: { readonly os: string; readonly architecture: string; readonly abi: string };
  readonly packageVersion: string | null;
  readonly entries: readonly CodexArtifactEntry[];
}): string {
  const entries = [...input.entries].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return sha256(Buffer.from(canonicalJson({
    layout: input.layout,
    target: input.target,
    packageVersion: input.packageVersion,
    entries
  }), "utf8"));
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function parsePackageRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, field: string, maxLength = 256): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
  return value;
}

function packageVersion(record: Record<string, unknown>): string {
  const version = stringField(record, "version");
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(version)) {
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
  return version;
}

function modeOf(stats: { readonly mode: bigint }): number {
  const mode = Number(stats.mode & 0o777n);
  if ((stats.mode & 0o6000n) !== 0n) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  return mode;
}

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

function isNative(bytes: Uint8Array): boolean {
  return bytes.length >= ELF_MAGIC.length && Buffer.from(bytes.subarray(0, ELF_MAGIC.length)).equals(ELF_MAGIC);
}

function targetDescriptor(target: string): { os: string; architecture: string; abi: string } {
  const parts = target.split("-");
  if (parts.length < 3 || parts.some((part) => !/^[A-Za-z0-9_]+$/u.test(part))) {
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
  const osIndex = parts.findIndex((part) => part === "linux");
  if (osIndex < 1 || osIndex === parts.length - 1) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  const architecture = parts.slice(0, osIndex).join("-");
  const abi = parts.slice(osIndex + 1).join("-");
  if (architecture.length === 0 || abi.length === 0) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  return { os: "linux", architecture, abi };
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    const { bytes } = await readRegularFileNoFollow(filePath, MAX_PACKAGE_JSON_BYTES);
    try {
      return parsePackageRecord(JSON.parse(bytes.toString("utf8")) as unknown);
    } catch (error) {
      if (error instanceof CodexArtifactIdentityError) throw error;
      throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
    }
  } catch (error) {
    if (error instanceof CodexArtifactIdentityError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
}

async function readLinkStable(filePath: string, root: string): Promise<{ target: string; identity: FileIdentity }> {
  const before = await lstatIdentity(filePath);
  if (before === null || !before.stats.isSymbolicLink()) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  let target: string;
  try { target = await readlink(filePath, "utf8"); }
  catch { throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM"); }
  if (target.length === 0 || path.isAbsolute(target) || target.includes("\0")) {
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
  const targetPath = path.resolve(path.dirname(filePath), target);
  if (!isContained(root, targetPath)) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  let targetReal: string;
  try { targetReal = await realpath(targetPath); }
  catch { throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM"); }
  if (!isContained(root, targetReal)) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  const after = await lstatIdentity(filePath);
  if (after === null || !identitiesEqual(before.identity, after.identity)) {
    throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
  }
  return { target, identity: after.identity };
}

async function collectEntries(root: string, paths: readonly string[]): Promise<CodexArtifactEntry[]> {
  const entries = new Map<string, CodexArtifactEntry>();
  let totalBytes = 0;

  const visit = async (absolutePath: string, relativePath: string, depth: number): Promise<void> => {
    if (depth > MAX_DIRECTORY_DEPTH) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
    if (entries.size > MAX_CLOSURE_ENTRIES) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
    const observed = await lstatIdentity(absolutePath);
    if (observed === null) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
    const { stats } = observed;
    if (stats.isDirectory()) {
      const children = await readdir(absolutePath, { withFileTypes: true });
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
        if (child.name === "." || child.name === ".." || child.name.includes("\0")) {
          throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
        }
        await visit(path.join(absolutePath, child.name), `${relativePath}/${child.name}`, depth + 1);
      }
      return;
    }
    if (stats.isSymbolicLink()) {
      const link = await readLinkStable(absolutePath, root);
      const mode = modeOf(stats);
      const entry: CodexArtifactEntry = {
        relativePath: relativePath.replaceAll(path.sep, "/"), kind: "symlink", mode,
        linkTarget: link.target, byteLength: 0, sha256: null
      };
      if (entries.has(entry.relativePath)) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
      entries.set(entry.relativePath, entry);
      return;
    }
    if (!stats.isFile() || stats.nlink !== 1n) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
    const mode = modeOf(stats);
    if (stats.size > BigInt(MAX_ENTRY_BYTES)) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
    const read = await readRegularFileNoFollow(absolutePath, MAX_ENTRY_BYTES);
    if (!identitiesEqual(observed.identity, read.identity)) throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
    totalBytes += read.bytes.length;
    if (totalBytes > MAX_CLOSURE_BYTES) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
    const entry: CodexArtifactEntry = {
      relativePath: relativePath.replaceAll(path.sep, "/"), kind: "file", mode,
      linkTarget: null, byteLength: read.bytes.length, sha256: sha256(read.bytes)
    };
    if (entries.has(entry.relativePath)) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
    entries.set(entry.relativePath, entry);
  };

  for (const relative of paths) {
    if (relative.startsWith("/") || relative.split("/").some((part) => part === ".." || part === "")) {
      throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
    }
    await visit(path.join(root, ...relative.split("/")), relative, 0);
  }
  const result = [...entries.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (result.length === 0 || result.length > MAX_CLOSURE_ENTRIES) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  return result;
}

async function assertStandaloneTopLevel(root: string): Promise<void> {
  const children = await readdir(root, { withFileTypes: true });
  if (children.some((child) => !standaloneTopLevelNames.has(child.name))) {
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
}

async function assertDirectory(directory: string): Promise<void> {
  const observed = await lstatIdentity(directory);
  if (observed === null || !observed.stats.isDirectory() || observed.stats.isSymbolicLink()) {
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
}

async function assertRegularNative(filePath: string): Promise<{ bytes: Buffer; mode: number; identity: FileIdentity }> {
  const read = await readRegularFileNoFollow(filePath, MAX_ENTRY_BYTES);
  const mode = modeOf(read.stats);
  if (!isExecutable(mode) || !isNative(read.bytes)) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  return { bytes: read.bytes, mode, identity: read.identity };
}

function makeArtifact(input: {
  readonly configuredPath: string;
  readonly root: string;
  readonly layout: CodexArtifactLayout;
  readonly target: { readonly os: string; readonly architecture: string; readonly abi: string };
  readonly packageVersion: string | null;
  readonly entrypointRelativePath: string;
  readonly entries: readonly CodexArtifactEntry[];
}): CodexExecutionArtifact {
  const entries = [...input.entries].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const entrypoint = entries.find((entry) => entry.relativePath === input.entrypointRelativePath && entry.kind === "file");
  if (entrypoint === undefined || entrypoint.sha256 === null) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  const closureDigest = codexExecutionArtifactClosureDigest({
    layout: input.layout, target: input.target, packageVersion: input.packageVersion, entries
  });
  return {
    configuredPath: input.configuredPath,
    canonicalSourceRoot: input.root,
    layout: input.layout,
    target: input.target,
    packageVersion: input.packageVersion,
    entrypoint,
    entries,
    entrypointSha256: entrypoint.sha256,
    closureDigest
  };
}

async function findAncestorWithFile(start: string, fileName: string): Promise<string | null> {
  let current = path.resolve(start);
  for (let index = 0; index < MAX_PACKAGE_ANCESTORS; index += 1) {
    const candidate = path.join(current, fileName);
    const observed = await lstatIdentity(candidate);
    if (observed !== null) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

async function resolveStandalone(configuredPath: string, canonicalEntrypoint: string, packageRoot: string): Promise<CodexExecutionArtifact> {
  const root = await realpath(packageRoot);
  await assertDirectory(root);
  const packageData = await readJson(path.join(root, "codex-package.json"));
  if (packageData.layoutVersion !== 1 || packageData.variant !== "codex") {
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
  const version = packageVersion(packageData);
  const target = targetDescriptor(stringField(packageData, "target"));
  if (stringField(packageData, "entrypoint") !== "bin/codex"
    || stringField(packageData, "resourcesDir") !== "codex-resources"
    || stringField(packageData, "pathDir") !== "codex-path") {
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
  const entrypointPath = path.join(root, "bin", "codex");
  if (await realpath(entrypointPath).catch(() => "") !== canonicalEntrypoint) {
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
  await assertStandaloneTopLevel(root);
  await assertDirectory(path.join(root, "bin"));
  await assertDirectory(path.join(root, "codex-resources"));
  await assertDirectory(path.join(root, "codex-path"));
  await assertRegularNative(entrypointPath);
  const helper = await lstatIdentity(path.join(root, "bin", "codex-code-mode-host"));
  if (helper === null || !helper.stats.isFile()) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  const convenience = await lstatIdentity(path.join(root, "codex"));
  if (convenience !== null) {
    if (!convenience.stats.isSymbolicLink()) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
    const link = await readLinkStable(path.join(root, "codex"), root);
    if (link.target !== "bin/codex") throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
  const entries = await collectEntries(root, [
    "codex-package.json", "bin", "codex-resources", "codex-path", ...(convenience === null ? [] : ["codex"])
  ]);
  if (entries.length > MAX_CLOSURE_ENTRIES) {
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
  const collectedEntrypoint = entries.find((entry) => entry.relativePath === "bin/codex");
  const revalidatedEntrypoint = await assertRegularNative(entrypointPath);
  if (collectedEntrypoint?.sha256 !== sha256(revalidatedEntrypoint.bytes)) {
    throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
  }
  return makeArtifact({ configuredPath, root, layout: "standalone-package", target, packageVersion: version,
    entrypointRelativePath: "bin/codex", entries });
}

function packageBinPath(packageData: Record<string, unknown>): string {
  const bin = packageData.bin;
  const value = typeof bin === "string" ? bin : bin !== null && typeof bin === "object" && !Array.isArray(bin)
    ? (bin as Record<string, unknown>).codex : undefined;
  if (value !== "bin/codex.js") throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  return value;
}

async function findNodeNativePayload(root: string, packageData: Record<string, unknown>): Promise<{
  readonly packageRoot: string;
  readonly packageData: Record<string, unknown>;
  readonly relativePackageRoot: string;
  readonly relativeTarget: string;
  readonly target: { readonly os: string; readonly architecture: string; readonly abi: string };
}> {
  const optional = packageData.optionalDependencies;
  if (optional === null || typeof optional !== "object" || Array.isArray(optional)) {
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
  const candidates: Array<{
    packageRoot: string;
    packageData: Record<string, unknown>;
    relativePackageRoot: string;
    relativeTarget: string;
    target: { os: string; architecture: string; abi: string };
  }> = [];
  for (const dependencyName of Object.keys(optional).sort()) {
    if (!/^@openai\/codex-[A-Za-z0-9-]+$/u.test(dependencyName)) continue;
    const dependencyRoot = path.join(root, "node_modules", ...dependencyName.split("/"));
    const dependencyRecord = await readJson(path.join(dependencyRoot, "package.json")).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (dependencyRecord === null) continue;
    if (dependencyRecord.name !== dependencyName || packageVersion(dependencyRecord) !== packageVersion(packageData)) {
      throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
    }
    const vendorRoot = path.join(dependencyRoot, "vendor");
    const vendorChildren = await readdir(vendorRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as Dirent[];
      throw error;
    });
    for (const vendorChild of vendorChildren.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!vendorChild.isDirectory() || !/^[A-Za-z0-9_+-]+$/u.test(vendorChild.name)) {
        throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
      }
      const targetRoot = path.join(vendorRoot, vendorChild.name);
      const nativePath = path.join(targetRoot, "bin", "codex");
      const nativeObserved = await lstatIdentity(nativePath);
      if (nativeObserved === null) continue;
      const target = targetDescriptor(vendorChild.name);
      await assertRegularNative(nativePath);
      candidates.push({
        packageRoot: dependencyRoot,
        packageData: dependencyRecord,
        relativePackageRoot: path.relative(root, dependencyRoot).split(path.sep).join("/"),
        relativeTarget: path.relative(root, targetRoot).split(path.sep).join("/"),
        target
      });
    }
  }
  if (candidates.length !== 1) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  return candidates[0]!;
}

async function resolveNodePackage(configuredPath: string, canonicalEntrypoint: string, packageRoot: string): Promise<CodexExecutionArtifact> {
  const root = await realpath(packageRoot);
  await assertDirectory(root);
  const packageData = await readJson(path.join(root, "package.json"));
  if (packageData.name !== "@openai/codex") throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  const version = packageVersion(packageData);
  if (path.relative(root, canonicalEntrypoint).split(path.sep).join("/") !== "bin/codex.js") {
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
  packageBinPath(packageData);
  const wrapper = await readRegularFileNoFollow(canonicalEntrypoint, MAX_ENTRY_BYTES);
  if (!isExecutable(modeOf(wrapper.stats)) || isNative(wrapper.bytes)) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  const payload = await findNodeNativePayload(root, packageData);
  const nativeRelative = `${payload.relativeTarget}/bin/codex`;
  const nativePath = path.join(root, ...nativeRelative.split("/"));
  const native = await assertRegularNative(nativePath);
  const entries = await collectEntries(root, ["package.json", "bin/codex.js", `${payload.relativePackageRoot}/package.json`, payload.relativeTarget]);
  const collectedEntrypoint = entries.find((entry) => entry.relativePath === nativeRelative);
  if (collectedEntrypoint?.sha256 !== sha256(native.bytes)) {
    throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
  }
  return makeArtifact({ configuredPath, root, layout: "official-node-native-payload", target: payload.target,
    packageVersion: version, entrypointRelativePath: nativeRelative, entries });
}

async function resolveDirectNative(configuredPath: string, canonicalEntrypoint: string): Promise<CodexExecutionArtifact> {
  const root = path.dirname(canonicalEntrypoint);
  await assertDirectory(root);
  const native = await assertRegularNative(canonicalEntrypoint);
  const relative = path.basename(canonicalEntrypoint);
  const entry: CodexArtifactEntry = {
    relativePath: relative, kind: "file", mode: native.mode, linkTarget: null,
    byteLength: native.bytes.length, sha256: sha256(native.bytes)
  };
  return makeArtifact({ configuredPath, root, layout: "self-contained-native",
    target: { os: process.platform, architecture: process.arch, abi: "native" }, packageVersion: null,
    entrypointRelativePath: relative, entries: [entry] });
}

export async function resolveCodexExecutionArtifact(configuredPath: string): Promise<CodexExecutionArtifact> {
  const privatePath = path.resolve(configuredPath);
  let canonicalEntrypoint: string;
  try { canonicalEntrypoint = await realpath(privatePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw artifactError("CODEX_EXECUTABLE_MISSING");
    throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  }
  const standaloneRoot = await findAncestorWithFile(path.dirname(canonicalEntrypoint), "codex-package.json");
  if (standaloneRoot !== null) return await resolveStandalone(privatePath, canonicalEntrypoint, standaloneRoot);
  const nodeRoot = await findAncestorWithFile(path.dirname(canonicalEntrypoint), "package.json");
  if (nodeRoot !== null) {
    const nodeData = await readJson(path.join(nodeRoot, "package.json"));
    if (nodeData.name === "@openai/codex") return await resolveNodePackage(privatePath, canonicalEntrypoint, nodeRoot);
  }
  return await resolveDirectNative(privatePath, canonicalEntrypoint);
}

function entrySourcePath(artifact: CodexExecutionArtifact, entry: CodexArtifactEntry): string {
  const relative = entry.relativePath.split("/");
  if (relative.some((part) => part === "" || part === "." || part === "..")) throw artifactError("CODEX_UNRECOGNIZED_EXECUTION_FORM");
  return path.join(artifact.canonicalSourceRoot, ...relative);
}

async function copyEntry(artifact: CodexExecutionArtifact, entry: CodexArtifactEntry, destinationRoot: string): Promise<void> {
  const source = entrySourcePath(artifact, entry);
  const destination = path.join(destinationRoot, ...entry.relativePath.split("/"));
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (entry.kind === "symlink") {
    const sourceObserved = await lstatIdentity(source);
    if (sourceObserved === null || !sourceObserved.stats.isSymbolicLink()
      || modeOf(sourceObserved.stats) !== entry.mode) throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
    const link = await readLinkStable(source, artifact.canonicalSourceRoot);
    if (link.target !== entry.linkTarget || !identitiesEqual(sourceObserved.identity, link.identity)) {
      throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
    }
    await symlink(entry.linkTarget, destination);
    return;
  }
  const sourceObserved = await lstatIdentity(source);
  if (sourceObserved === null || !sourceObserved.stats.isFile() || sourceObserved.stats.nlink !== 1n
    || modeOf(sourceObserved.stats) !== entry.mode) throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
  const read = await readRegularFileNoFollow(source, MAX_ENTRY_BYTES);
  if (!identitiesEqual(sourceObserved.identity, read.identity)
    || read.bytes.length !== entry.byteLength || sha256(read.bytes) !== entry.sha256) {
    throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
  }
  await writeFile(destination, read.bytes, { mode: entry.mode, flag: "wx" });
  await chmod(destination, entry.mode);
}

const stageLocks = new Map<string, Promise<void>>();

async function withStageLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = stageLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  stageLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (stageLocks.get(key) === current) stageLocks.delete(key);
  }
}

function stagedArtifact(artifact: CodexExecutionArtifact, stagingRoot: string,
  cacheState: StagedCodexExecutionArtifact["cacheState"]): StagedCodexExecutionArtifact {
  return {
    artifact,
    stagingRoot,
    entrypointPath: path.join(stagingRoot, ...artifact.entrypoint.relativePath.split("/")),
    readbackManifestPath: path.join(stagingRoot, "manifest.json"),
    cacheState
  };
}

async function verifySourceEntries(artifact: CodexExecutionArtifact): Promise<void> {
  for (const entry of artifact.entries) {
    const source = entrySourcePath(artifact, entry);
    const observed = await lstatIdentity(source);
    if (observed === null) throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
    if (entry.kind === "symlink") {
      if (!observed.stats.isSymbolicLink() || modeOf(observed.stats) !== entry.mode) {
        throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
      }
      const link = await readLinkStable(source, artifact.canonicalSourceRoot);
      if (link.target !== entry.linkTarget || !identitiesEqual(observed.identity, link.identity)) {
        throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
      }
      continue;
    }
    if (!observed.stats.isFile() || observed.stats.nlink !== 1n) {
      throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
    }
    const read = await readRegularFileNoFollow(source, MAX_ENTRY_BYTES);
    if (!identitiesEqual(observed.identity, read.identity) || read.bytes.length !== entry.byteLength
      || sha256(read.bytes) !== entry.sha256 || modeOf(read.stats) !== entry.mode) {
      throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
    }
  }
}

async function quarantineStagedArtifact(candidateRoot: string, artifactDirectory: string,
  closureDigest: string): Promise<boolean> {
  const observed = await lstatIdentity(candidateRoot);
  if (observed === null) return false;
  const quarantineRoot = path.join(artifactDirectory,
    `.quarantine-${closureDigest}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    await rename(candidateRoot, quarantineRoot);
    return true;
  } catch (error) {
    // A separate Agent process may have quarantined this same invalid candidate.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function cacheCandidateNames(names: readonly string[], closureDigest: string): string[] {
  const stableName = `codex-${closureDigest}`;
  const legacyPrefix = `${stableName}-`;
  return names.filter((name) => name === stableName || name.startsWith(legacyPrefix))
    .sort((left, right) => left === stableName ? -1 : right === stableName ? 1 : left.localeCompare(right));
}

async function findVerifiedStagedArtifact(input: {
  readonly artifact: CodexExecutionArtifact;
  readonly artifactDirectory: string;
}): Promise<{ staged: StagedCodexExecutionArtifact | null; repaired: boolean }> {
  let repaired = false;
  const names = cacheCandidateNames(await readdir(input.artifactDirectory), input.artifact.closureDigest);
  for (const name of names) {
    const candidateRoot = path.join(input.artifactDirectory, name);
    const candidate = stagedArtifact(input.artifact, candidateRoot, "hit");
    try {
      await verifyStagedCodexExecutionArtifact(candidate);
    } catch {
      repaired = await quarantineStagedArtifact(candidateRoot, input.artifactDirectory, input.artifact.closureDigest) || repaired;
      continue;
    }
    await verifySourceEntries(input.artifact);
    return { staged: candidate, repaired };
  }
  return { staged: null, repaired };
}

async function listStagedEntries(root: string): Promise<Set<string>> {
  const result = new Set<string>();
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const relative = relativeDirectory.length === 0 ? child.name : `${relativeDirectory}/${child.name}`;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) await visit(absolute, relative);
      else if (child.isFile() || child.isSymbolicLink()) result.add(relative);
      else throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
    }
  };
  await visit(root, "");
  return result;
}

async function verifyEntries(artifact: CodexExecutionArtifact, root: string): Promise<void> {
  const expected = new Set(artifact.entries.map((entry) => entry.relativePath));
  for (const entry of artifact.entries) {
    const target = path.join(root, ...entry.relativePath.split("/"));
    const observed = await lstatIdentity(target);
    if (observed === null) throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
    if (entry.kind === "symlink") {
      if (!observed.stats.isSymbolicLink() || modeOf(observed.stats) !== entry.mode) {
        throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
      }
      const link = await readLinkStable(target, root);
      if (link.target !== entry.linkTarget) throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
      continue;
    }
    if (!observed.stats.isFile()) throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
    const read = await readRegularFileNoFollow(target, MAX_ENTRY_BYTES);
    if (read.bytes.length !== entry.byteLength || sha256(read.bytes) !== entry.sha256 || modeOf(read.stats) !== entry.mode) {
      throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
    }
  }
  const actual = await listStagedEntries(root);
  actual.delete("manifest.json");
  if (actual.size !== expected.size || [...actual].some((entry) => !expected.has(entry))) {
    throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
  }
}

export async function stageCodexExecutionArtifact(input: {
  readonly artifact: CodexExecutionArtifact;
  readonly stateRoot: string;
}): Promise<StagedCodexExecutionArtifact> {
  const base = path.resolve(input.stateRoot);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  const artifactDirectory = path.join(base, "codex-artifacts");
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await chmod(artifactDirectory, 0o700);
  const artifactEntrypoint = input.artifact.entries.find((entry) => entry.relativePath === input.artifact.entrypoint.relativePath);
  if (!/^[a-f0-9]{64}$/u.test(input.artifact.closureDigest)
    || codexExecutionArtifactClosureDigest({
      layout: input.artifact.layout, target: input.artifact.target,
      packageVersion: input.artifact.packageVersion, entries: input.artifact.entries
    }) !== input.artifact.closureDigest
    || artifactEntrypoint === undefined || artifactEntrypoint.kind !== "file"
    || artifactEntrypoint.sha256 !== input.artifact.entrypointSha256
    || canonicalJson(artifactEntrypoint) !== canonicalJson(input.artifact.entrypoint)) {
    throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
  }
  const lockKey = `${artifactDirectory}\0${input.artifact.closureDigest}`;
  return await withStageLock(lockKey, async () => {
    const cached = await findVerifiedStagedArtifact({ artifact: input.artifact, artifactDirectory });
    if (cached.staged !== null) {
      return cached.repaired
        ? { ...cached.staged, cacheState: "repaired" }
        : cached.staged;
    }

    const temporaryRoot = await mkdtemp(path.join(artifactDirectory, `.stage-${input.artifact.closureDigest}-`));
    await chmod(temporaryRoot, 0o700);
    try {
      for (const entry of input.artifact.entries) await copyEntry(input.artifact, entry, temporaryRoot);
      const manifestPath = path.join(temporaryRoot, "manifest.json");
      await durableJsonWriter.write(manifestPath, {
        closureDigest: input.artifact.closureDigest,
        entrypointSha256: input.artifact.entrypointSha256,
        entries: input.artifact.entries
      });
      const cacheState = cached.repaired ? "repaired" : "miss";
      const stagedTemporary = stagedArtifact(input.artifact, temporaryRoot, cacheState);
      await verifyStagedCodexExecutionArtifact(stagedTemporary);

      const finalRoot = path.join(artifactDirectory, `codex-${input.artifact.closureDigest}`);
      try {
        await rename(temporaryRoot, finalRoot);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
        const concurrentlyPublished = stagedArtifact(input.artifact, finalRoot, "hit");
        await verifyStagedCodexExecutionArtifact(concurrentlyPublished);
        await verifySourceEntries(input.artifact);
        await rm(temporaryRoot, { recursive: true, force: true });
        return cached.repaired
          ? { ...concurrentlyPublished, cacheState: "repaired" }
          : concurrentlyPublished;
      }
      return stagedArtifact(input.artifact, finalRoot, cacheState);
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export async function verifyStagedCodexExecutionArtifact(staged: StagedCodexExecutionArtifact): Promise<void> {
  const root = path.resolve(staged.stagingRoot);
  const expectedEntrypoint = path.join(root, ...staged.artifact.entrypoint.relativePath.split("/"));
  if (path.resolve(staged.entrypointPath) !== expectedEntrypoint
    || path.resolve(staged.readbackManifestPath) !== path.join(root, "manifest.json")) {
    throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
  }
  const observed = await lstatIdentity(root);
  if (observed === null || !observed.stats.isDirectory() || observed.stats.isSymbolicLink()) {
    throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
  }
  const expectedManifest = {
    closureDigest: staged.artifact.closureDigest,
    entrypointSha256: staged.artifact.entrypointSha256,
    entries: staged.artifact.entries
  };
  const expectedManifestBytes = Buffer.from(`${JSON.stringify(expectedManifest)}\n`, "utf8");
  const manifest = await readRegularFileNoFollow(staged.readbackManifestPath, expectedManifestBytes.byteLength);
  if (modeOf(manifest.stats) !== 0o600) throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
  if (!manifest.bytes.equals(expectedManifestBytes)) throw artifactError("CODEX_EXECUTABLE_INTEGRITY_CHANGED");
  await verifyEntries(staged.artifact, root);
}
