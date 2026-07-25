import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const genericComposePath = "deploy/preview-gateway/compose.yaml";
const coolifyComposePath = "deploy/preview-gateway/compose.coolify.yaml";
const connectorServiceName = "preview-ingress-connector";
const proxyNetworkKey = "coolify-proxy";
const proxyNetworkAlias = "devspace-preview-ingress";
const proxyNetworkExpression =
  "${DEVSPACE_COOLIFY_PROXY_NETWORK:?DEVSPACE_COOLIFY_PROXY_NETWORK must be set and non-empty}";
const generatedHeader = [
  "# Generated from compose.yaml by tooling/generate-preview-gateway-coolify-compose.mjs.",
  "# Run `pnpm preview-gateway:coolify-generate` after changing the generic contract.",
  ""
].join("\n");

function fail(message) {
  throw new Error(`Coolify Compose generation failed: ${message}`);
}

function object(value, description) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${description} must be an object.`);
  }
  return value;
}

function rejectComposeDependencies(value, location = "root") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectComposeDependencies(entry, `${location}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "include" || key === "extends") {
      fail(`${location}.${key} is forbidden because Coolify materializes only the selected Compose artifact.`);
    }
    rejectComposeDependencies(child, `${location}.${key}`);
  }
}

export function parseCompose(source, description) {
  let model;
  try {
    model = parse(source, { maxAliasCount: 0, merge: false, prettyErrors: true });
  } catch (error) {
    fail(`${description} is invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  return object(model, description);
}

export function deriveCoolifyComposeModel(genericModel) {
  const model = structuredClone(object(genericModel, "generic Compose model"));
  rejectComposeDependencies(model);
  const services = object(model.services, "generic services");
  const connector = object(services[connectorServiceName], `generic service ${connectorServiceName}`);
  if (connector.networks !== undefined) {
    fail(`${connectorServiceName} must not already define networks in the provider-neutral contract.`);
  }
  if (model.networks !== undefined) {
    fail("the provider-neutral contract must not already define top-level networks.");
  }

  connector.networks = {
    [proxyNetworkKey]: {
      aliases: [proxyNetworkAlias]
    }
  };
  model.networks = {
    [proxyNetworkKey]: {
      external: true,
      name: proxyNetworkExpression
    }
  };
  return model;
}

export function generateCoolifyPreviewGatewayCompose(genericSource) {
  const genericModel = parseCompose(genericSource, "generic Compose file");
  const model = deriveCoolifyComposeModel(genericModel);
  return generatedHeader + stringify(model, {
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
    lineWidth: 0
  });
}

export async function expectedCoolifyPreviewGatewayCompose(root = repositoryRoot) {
  const genericSource = await readFile(path.join(root, genericComposePath), "utf8");
  return generateCoolifyPreviewGatewayCompose(genericSource);
}

export async function verifyCoolifyPreviewGatewayCompose(root = repositoryRoot) {
  const [expected, actual] = await Promise.all([
    expectedCoolifyPreviewGatewayCompose(root),
    readFile(path.join(root, coolifyComposePath), "utf8")
  ]);
  if (actual !== expected) {
    fail("committed compose.coolify.yaml has drifted; run `pnpm preview-gateway:coolify-generate`.");
  }
  return true;
}

async function main() {
  const mode = process.argv[2] ?? "--check";
  if (mode === "--check") {
    await verifyCoolifyPreviewGatewayCompose();
    console.log("generated Coolify Compose artifact is current");
    return;
  }
  if (mode === "--write") {
    const expected = await expectedCoolifyPreviewGatewayCompose();
    await writeFile(path.join(repositoryRoot, coolifyComposePath), expected);
    console.log(`generated ${coolifyComposePath}`);
    return;
  }
  fail("usage: node tooling/generate-preview-gateway-coolify-compose.mjs [--check|--write]");
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
