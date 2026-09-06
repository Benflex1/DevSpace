import { expect, test } from "vitest";
import { classifyAuthenticatedGitFailure, type AuthenticatedGitFailureResult } from "./authenticated-git-failure.js";

function failed(stderr: string, overrides: Partial<AuthenticatedGitFailureResult> = {}): AuthenticatedGitFailureResult {
  return { stdout: "", stderr, code: 128, signal: null, ...overrides };
}

test.each([
  "fatal: Authentication failed for 'https://github.com/org/private-repo.git/'",
  "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  "fatal: invalid username or password",
  "fatal: unable to access 'https://github.com/org/private-repo.git/': HTTP 401",
  "fatal: unable to access 'https://github.com/org/private-repo.git/': HTTP 403",
  "remote: access denied"
])("classifies known GitHub authentication rejection as authentication: %s", (stderr) => {
  expect(classifyAuthenticatedGitFailure(failed(stderr))).toBe("authentication");
});

test.each([
  "fatal: unable to access 'https://github.com/org/private-repo.git/': Could not resolve host: github.com",
  "fatal: unable to access 'https://github.com/org/private-repo.git/': Failed to connect to github.com port 443 after 1 ms: Couldn't connect to server",
  "fatal: unable to access 'https://github.com/org/private-repo.git/': Connection refused",
  "fatal: unable to access 'https://github.com/org/private-repo.git/': Recv failure: Connection reset by peer",
  "fatal: the remote end hung up unexpectedly",
  "fetch-pack: unexpected disconnect while reading sideband packet",
  "fatal: unable to access 'https://github.com/org/private-repo.git/': The requested URL returned error: 503",
  "fatal: unable to access 'https://github.com/org/private-repo.git/': gnutls_handshake() failed: The TLS connection was non-properly terminated."
])("classifies a positive remote transport failure as remote-source: %s", (stderr) => {
  expect(classifyAuthenticatedGitFailure(failed(stderr))).toBe("remote-source");
});

test.each([
  "fatal: cannot create directory at 'repository.git': Permission denied",
  "fatal: not a git repository (or any of the parent directories): .git",
  "fatal: unable to write loose object: No space left on device",
  "error: cannot lock ref 'refs/remotes/origin/main': is at old but expected new",
  "fatal: object database is corrupt",
  "fatal: unexpected private Git failure"
])("keeps local and unknown Git failures internal: %s", (stderr) => {
  expect(classifyAuthenticatedGitFailure(failed(stderr))).toBe("internal");
});

test("keeps an unexpected signal internal even when stderr contains unrelated text", () => {
  expect(classifyAuthenticatedGitFailure(failed("connection refused", { signal: "SIGTERM" }))).toBe("internal");
});

test("classifies the bounded production timeout as remote-source", () => {
  const result = failed("", { code: null, signal: "SIGTERM", timedOut: true });
  expect(classifyAuthenticatedGitFailure(result)).toBe("remote-source");
});
