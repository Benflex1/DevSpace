import { expect, test } from "vitest";
import { assertAdmittedCodexVersion, parseCodexVersionOutput } from "./compatibility.js";

test("parses the native Codex version line", () => {
  expect(parseCodexVersionOutput("codex-cli 0.153.4\n")).toBe("0.153.4");
  expect(parseCodexVersionOutput("codex 0.153.4 (native)\n")).toBe("0.153.4");
});

test("admits only the exact 0.153.4 executable", () => {
  expect(assertAdmittedCodexVersion({
    executablePath: "/srv/devspace/bin/codex",
    versionOutput: "codex-cli 0.153.4\n"
  })).toEqual({
    executablePath: "/srv/devspace/bin/codex",
    versionOutput: "codex-cli 0.153.4\n",
    version: "0.153.4",
    exact: true
  });
  expect(() => assertAdmittedCodexVersion({
    executablePath: "/srv/devspace/bin/codex",
    versionOutput: "codex-cli 0.153.5\n"
  })).toThrow("codex-version-not-admitted");
  expect(() => assertAdmittedCodexVersion({
    executablePath: "relative/codex",
    versionOutput: "codex-cli 0.153.4\n"
  })).toThrow("codex-executable-path-invalid");
  expect(() => assertAdmittedCodexVersion({
    executablePath: "/srv/devspace/bin/codex\0unsafe",
    versionOutput: "codex-cli 0.153.4\n"
  })).toThrow("codex-executable-path-invalid");
  expect(() => assertAdmittedCodexVersion({
    executablePath: "/srv/devspace/bin/codex",
    versionOutput: "not a version\n"
  })).toThrow("codex-version-output-invalid");
});
