import eslint from "@eslint/js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import globals from "globals";
import tseslint from "typescript-eslint";
import {
  expectedPackages,
  isTestOnlyPath,
  testkitPackageName
} from "./tooling/workspace-graph.mjs";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectories = new Map(
  [...expectedPackages].map(([directory, definition]) => [directory, definition.name])
);
const internalPackages = new Set(packageDirectories.values());
const packageManifests = new Map(
  [...expectedPackages].map(([directory, definition]) => {
    const manifestPath = path.resolve(rootDirectory, directory, "package.json");
    try {
      return [definition.name, JSON.parse(readFileSync(manifestPath, "utf8"))];
    } catch {
      return [definition.name, {}];
    }
  })
);
const testkitDevDependencyPackages = new Set(
  [...packageManifests].filter(([, manifest]) => (
    manifest.devDependencies?.[testkitPackageName] === "workspace:*"
  )).map(([packageName]) => packageName)
);
const allowedImports = new Map(
  [...expectedPackages.values()].map((definition) => [definition.name, new Set(definition.dependencies)])
);

function relativePathForFile(filename) {
  if (!path.isAbsolute(filename)) {
    return null;
  }
  return path.relative(rootDirectory, filename).replaceAll("\\", "/");
}

function packageForFile(filename) {
  const relativeFilename = relativePathForFile(filename);
  if (relativeFilename === null) {
    return null;
  }
  for (const [directory, packageName] of packageDirectories) {
    if (relativeFilename === directory || relativeFilename.startsWith(`${directory}/`)) {
      return packageName;
    }
  }
  return null;
}

function isTestOnlyFile(filename) {
  const relativeFilename = relativePathForFile(filename);
  return relativeFilename !== null && isTestOnlyPath(relativeFilename);
}

const boundaryPlugin = {
  rules: {
    "package-boundaries": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          unknown: "Do not import unknown or deferred internal package '{{name}}'.",
          deep: "Import '{{name}}' through its public package entry point; deep internal imports are prohibited.",
          testkitSource: "Package '{{name}}' may be imported only from test-only files.",
          testkitDependency: "Package '{{from}}' must declare @devspace/testkit as devDependencies: workspace:* before importing it.",
          forbidden: "Package '{{from}}' may not import internal package '{{to}}'."
        }
      },
      create(context) {
        const sourcePackage = packageForFile(context.filename);
        if (sourcePackage === null) {
          return {};
        }

        function checkImport(sourceNode) {
          const source = sourceNode.value;
          if (typeof source !== "string") {
            return;
          }
          const match = /^(@devspace\/[^/]+)(\/.*)?$/.exec(source);
          if (match === null) {
            return;
          }

          const targetPackage = match[1];
          if (!internalPackages.has(targetPackage)) {
            context.report({ node: sourceNode, messageId: "unknown", data: { name: targetPackage } });
            return;
          }
          if (match[2] !== undefined) {
            context.report({ node: sourceNode, messageId: "deep", data: { name: source } });
            return;
          }
          if (targetPackage === testkitPackageName) {
            if (!isTestOnlyFile(context.filename)) {
              context.report({
                node: sourceNode,
                messageId: "testkitSource",
                data: { name: testkitPackageName }
              });
            } else if (!testkitDevDependencyPackages.has(sourcePackage)) {
              context.report({
                node: sourceNode,
                messageId: "testkitDependency",
                data: { from: sourcePackage }
              });
            }
            return;
          }
          if (targetPackage === sourcePackage) {
            if (!isTestOnlyFile(context.filename)) {
              context.report({
                node: sourceNode,
                messageId: "forbidden",
                data: { from: sourcePackage, to: targetPackage }
              });
            }
            return;
          }
          if (!allowedImports.get(sourcePackage)?.has(targetPackage)) {
            context.report({
              node: sourceNode,
              messageId: "forbidden",
              data: { from: sourcePackage, to: targetPackage }
            });
          }
        }

        return {
          ImportDeclaration(node) {
            checkImport(node.source);
          },
          ImportExpression(node) {
            checkImport(node.source);
          },
          TSImportType(node) {
            checkImport(node.source);
          },
          ExportAllDeclaration(node) {
            checkImport(node.source);
          },
          ExportNamedDeclaration(node) {
            if (node.source !== null) {
              checkImport(node.source);
            }
          }
        };
      }
    }
  }
};

const sharedRules = {
  "devspace/package-boundaries": "error",
  "no-duplicate-imports": "error",
  "no-restricted-globals": [
    "error",
    { name: "require", message: "First-party source must use ESM imports." },
    { name: "module", message: "First-party source must use ESM exports." },
    { name: "exports", message: "First-party source must use ESM exports." }
  ],
  "no-restricted-syntax": [
    "error",
    {
      selector: "CallExpression[callee.name='require']",
      message: "First-party source must use ESM imports."
    },
    {
      selector: "MemberExpression[object.name='module'][property.name='exports']",
      message: "First-party source must use ESM exports."
    }
  ],
  "no-var": "error",
  "prefer-const": "error",
  "@typescript-eslint/no-require-imports": "error"
};

const unusedVariableOptions = {
  args: "all",
  argsIgnorePattern: "^_",
  caughtErrors: "all",
  caughtErrorsIgnorePattern: "^_",
  varsIgnorePattern: "^_"
};

const typeCheckedTypeScriptConfigs = tseslint.configs.recommendedTypeChecked.map((config) => ({
  ...config,
  files: ["**/*.ts"]
}));

export default tseslint.config(
  {
    ignores: [
      "**/.cache/**",
      "**/.git/**",
      "**/coverage/**",
      "**/.vitest/**",
      "**/dist/**",
      "**/generated/**",
      "**/node_modules/**",
      "schemas/**"
    ]
  },
  eslint.configs.recommended,
  ...typeCheckedTypeScriptConfigs,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: rootDirectory
      },
      globals: globals.node,
      sourceType: "module",
      ecmaVersion: "latest"
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      devspace: boundaryPlugin
    },
    rules: {
      ...sharedRules,
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      "@typescript-eslint/no-unused-vars": ["error", unusedVariableOptions]
    }
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      globals: globals.node,
      sourceType: "module",
      ecmaVersion: "latest"
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      devspace: boundaryPlugin
    },
    rules: {
      ...sharedRules,
      "no-unused-vars": ["error", unusedVariableOptions]
    }
  }
);
