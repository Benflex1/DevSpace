import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applicationNames,
  deferredDirectories,
  deferredPackageNames,
  expectedNames,
  expectedPackages
} from "./workspace-graph.mjs";

const defaultRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rootArgumentIndex = process.argv.indexOf("--root");
const root = rootArgumentIndex === -1
  ? defaultRoot
  : resolve(process.argv[rootArgumentIndex + 1] ?? "");

const errors = [];
const manifests = new Map();

function displayPath(filePath) {
  return relative(root, filePath).replaceAll("\\", "/") || ".";
}

function readManifest(relativePath) {
  const manifestPath = join(root, relativePath, "package.json");
  if (!existsSync(manifestPath)) {
    errors.push(`Missing expected package manifest: ${relativePath}/package.json`);
    return null;
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error("manifest is not a JSON object");
    }
    return manifest;
  } catch (error) {
    errors.push(`Cannot read ${relativePath}/package.json: ${error.message}`);
    return null;
  }
}

function findPackageManifests(directory) {
  if (!existsSync(directory)) {
    return [];
  }

  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isFile() && entry.name === "package.json") {
      found.push(entryPath);
    } else if (entry.isDirectory()) {
      found.push(...findPackageManifests(entryPath));
    }
  }
  return found;
}

for (const [relativePath, definition] of expectedPackages) {
  const manifest = readManifest(relativePath);
  if (manifest === null) {
    continue;
  }

  manifests.set(definition.name, { definition, manifest, relativePath });

  if (manifest.name !== definition.name) {
    errors.push(`${relativePath}/package.json must be named ${definition.name}, found ${String(manifest.name)}`);
  }
  if (manifest.private !== true) {
    errors.push(`${relativePath}/package.json must set private: true`);
  }
  if (manifest.type !== "module") {
    errors.push(`${relativePath}/package.json must set type: module`);
  }

  if (definition.kind === "library") {
    if (manifest.types !== "./dist/index.d.ts") {
      errors.push(`${relativePath}/package.json must point types to ./dist/index.d.ts`);
    }
    if (manifest.files?.length !== 1 || manifest.files[0] !== "dist") {
      errors.push(`${relativePath}/package.json must expose only the dist directory through files`);
    }
    if (manifest.exports?.["."]?.import !== "./dist/index.js" || manifest.exports?.["."]?.types !== "./dist/index.d.ts") {
      errors.push(`${relativePath}/package.json must export ./dist/index.js with ./dist/index.d.ts types`);
    }
  } else if ("exports" in manifest || "types" in manifest || "files" in manifest) {
    errors.push(`${relativePath}/package.json is an application boundary and must not expose library entry-point fields`);
  }
}

for (const deferredDirectory of deferredDirectories) {
  const deferredManifests = findPackageManifests(join(root, deferredDirectory));
  for (const manifestPath of deferredManifests) {
    errors.push(`Deferred directory ${deferredDirectory} must not contain a package manifest: ${displayPath(manifestPath)}`);
  }
}

for (const workspaceRoot of ["apps", "packages"]) {
  const directory = join(root, workspaceRoot);
  if (!existsSync(directory)) {
    errors.push(`Missing workspace directory: ${workspaceRoot}`);
    continue;
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const relativePath = `${workspaceRoot}/${entry.name}`;
    const manifestPath = join(directory, entry.name, "package.json");
    if (existsSync(manifestPath) && !expectedPackages.has(relativePath)) {
      errors.push(`Unexpected workspace package manifest: ${relativePath}/package.json`);
    }
  }
}

const nonProductionDependencyFields = ["optionalDependencies", "devDependencies", "peerDependencies"];
const graph = new Map([...expectedNames].map((name) => [name, []]));

function dependencyObject(packageData, field) {
  const dependencies = packageData.manifest[field];
  if (dependencies === undefined) {
    return {};
  }
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    errors.push(`${packageData.relativePath}/package.json field ${field} must be an object`);
    return {};
  }
  return dependencies;
}

for (const [packageName, packageData] of manifests) {
  const dependencies = dependencyObject(packageData, "dependencies");

  for (const requiredDependency of packageData.definition.dependencies) {
    if (!Object.hasOwn(dependencies, requiredDependency)) {
      errors.push(`${packageData.relativePath} is missing required internal production dependency ${requiredDependency} in dependencies`);
    } else if (dependencies[requiredDependency] !== "workspace:*") {
      errors.push(`${packageData.relativePath} must use workspace:* for ${requiredDependency}, found ${String(dependencies[requiredDependency])}`);
    }
  }

  for (const [dependencyName, version] of Object.entries(dependencies)) {
    if (!dependencyName.startsWith("@devspace/")) {
      continue;
    }
    if (version !== "workspace:*") {
      errors.push(`${packageData.relativePath} must use workspace:* for ${dependencyName}, found ${String(version)}`);
    }
    if (!expectedNames.has(dependencyName)) {
      if (deferredPackageNames.has(dependencyName)) {
        errors.push(`${packageData.relativePath} depends on deferred package ${dependencyName}`);
      } else {
        errors.push(`${packageData.relativePath} depends on unknown internal package ${dependencyName}`);
      }
      continue;
    }
    if (!packageData.definition.dependencies.includes(dependencyName)) {
      errors.push(`${packageData.relativePath} has a prohibited internal dependency on ${dependencyName}`);
      continue;
    }
    if (applicationNames.has(dependencyName)) {
      errors.push(`${packageData.relativePath} must not depend on application ${dependencyName}`);
      continue;
    }
    if (version === "workspace:*") {
      graph.get(packageName).push(dependencyName);
    }
  }

  for (const field of nonProductionDependencyFields) {
    const dependenciesInNonProductionField = dependencyObject(packageData, field);
    for (const dependencyName of Object.keys(dependenciesInNonProductionField)) {
      if (!dependencyName.startsWith("@devspace/")) {
        continue;
      }
      if (deferredPackageNames.has(dependencyName)) {
        errors.push(`${packageData.relativePath} depends on deferred package ${dependencyName} in ${field}`);
      } else if (!expectedNames.has(dependencyName)) {
        errors.push(`${packageData.relativePath} depends on unknown internal package ${dependencyName} in ${field}`);
      } else {
        errors.push(`${packageData.relativePath} must declare internal dependency ${dependencyName} in dependencies, not ${field}`);
      }
    }
  }
}

const visitState = new Map();
const visitStack = [];
function visit(packageName) {
  const state = visitState.get(packageName);
  if (state === "visiting") {
    const cycleStart = visitStack.indexOf(packageName);
    const cycle = [...visitStack.slice(cycleStart), packageName].join(" -> ");
    errors.push(`Internal workspace dependency cycle detected: ${cycle}`);
    return;
  }
  if (state === "visited") {
    return;
  }

  visitState.set(packageName, "visiting");
  visitStack.push(packageName);
  for (const dependencyName of graph.get(packageName) ?? []) {
    visit(dependencyName);
  }
  visitStack.pop();
  visitState.set(packageName, "visited");
}

for (const packageName of expectedNames) {
  visit(packageName);
}

if (errors.length > 0) {
  console.error("Workspace graph check failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Workspace graph is valid: ${expectedPackages.size} packages, no prohibited edges, no cycles.`);
}
