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
  ["packages/security", { name: "@devspace/security", kind: "library", dependencies: [] }]
]);

export const deferredDirectories = ["packages/testkit", "packages/gateway-caddy"];
export const deferredPackageNames = new Set(["@devspace/testkit", "@devspace/gateway-caddy"]);
export const expectedNames = new Set([...expectedPackages.values()].map((definition) => definition.name));
export const applicationNames = new Set(
  [...expectedPackages.values()]
    .filter((definition) => definition.kind === "application")
    .map((definition) => definition.name)
);
