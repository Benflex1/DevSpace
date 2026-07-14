export const expectedPackages = new Map([
  ["apps/web", { name: "@devspace/web", kind: "application", dependencies: [
    "@devspace/contracts",
    "@devspace/domain",
    "@devspace/project-options",
    "@devspace/database",
    "@devspace/security"
  ] }],
  ["apps/agent", { name: "@devspace/agent", kind: "application", dependencies: [
    "@devspace/contracts",
    "@devspace/domain",
    "@devspace/project-options",
    "@devspace/security"
  ] }],
  ["packages/contracts", { name: "@devspace/contracts", kind: "library", dependencies: [
    "@devspace/domain"
  ] }],
  ["packages/domain", { name: "@devspace/domain", kind: "library", dependencies: [] }],
  ["packages/database", { name: "@devspace/database", kind: "library", dependencies: [
    "@devspace/domain"
  ] }],
  ["packages/project-options", { name: "@devspace/project-options", kind: "library", dependencies: [
    "@devspace/security"
  ] }],
  ["packages/security", { name: "@devspace/security", kind: "library", dependencies: [] }],
  ["packages/testkit", { name: "@devspace/testkit", kind: "library", dependencies: [] }]
]);

export const testkitPackageName = "@devspace/testkit";
export function isTestOnlyPath(relativePath) {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const pathSegments = normalizedPath.split("/");
  const basename = pathSegments.at(-1) ?? "";

  return basename.endsWith(".test.ts")
    || basename.endsWith(".spec.ts")
    || pathSegments.includes("test")
    || pathSegments.includes("tests");
}

export const deferredDirectories = ["packages/gateway-caddy"];
export const deferredPackageNames = new Set(["@devspace/gateway-caddy"]);
export const expectedNames = new Set([...expectedPackages.values()].map((definition) => definition.name));
export const applicationNames = new Set(
  [...expectedPackages.values()]
    .filter((definition) => definition.kind === "application")
    .map((definition) => definition.name)
);
