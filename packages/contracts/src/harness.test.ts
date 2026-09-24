import { describe, expect, test } from "vitest";
import {
  harnessArgvSchema,
  classifyResumeArgv,
  parseResumeArgv,
  substituteResumeArgv,
  assertNativeSessionId,
  resumeCapability,
  customHarnessDefinitionSchema
} from "./harness.js";

test("rejects host paths and shell-like executables", () => {
  expect(harnessArgvSchema.safeParse({ executable: "/usr/bin/codex", args: [] }).success).toBe(false);
  expect(harnessArgvSchema.safeParse({ executable: "codex;id", args: [] }).success).toBe(false);
  expect(harnessArgvSchema.safeParse({ executable: "codex", args: ["resume"] }).success).toBe(true);
});

test("zero-placeholder resume is provider-handled and resumable without an id", () => {
  const resume = { executable: "my-agent", args: ["--resume"] };
  expect(classifyResumeArgv(resume)).toEqual({ kind: "provider-handled" });
  expect(resumeCapability({ resume, nativeSessionId: null })).toBe(true);
});

test("one whole-token placeholder requires a real native id", () => {
  const resume = { executable: "codex", args: ["resume", "{sessionId}"] };
  expect(classifyResumeArgv(resume)).toEqual({ kind: "native-id" });
  expect(resumeCapability({ resume, nativeSessionId: null })).toBe(false);
  expect(resumeCapability({ resume, nativeSessionId: "thread-live" })).toBe(true);
});

test("null resume is never offered", () => {
  expect(classifyResumeArgv(null)).toEqual({ kind: "none" });
  expect(resumeCapability({ resume: null, nativeSessionId: "thread-live" })).toBe(false);
});

test("rejects interpolation inside another token and multiple placeholders", () => {
  expect(() => parseResumeArgv({ executable: "codex", args: ["resume={sessionId}"] })).toThrow(/placeholder/);
  expect(() => parseResumeArgv({
    executable: "my-agent", args: ["{sessionId}", "{sessionId}"]
  })).toThrow(/placeholder/);
});

test("substitutes {sessionId} as exactly one argv token", () => {
  const out = substituteResumeArgv(
    { executable: "codex", args: ["resume", "{sessionId}"] },
    "0196abc-native"
  );
  expect(out).toEqual({ executable: "codex", args: ["resume", "0196abc-native"] });
});

test("custom definition rejects secret env and interpolated resume", () => {
  expect(customHarnessDefinitionSchema.safeParse({
    id: "my-agent",
    displayName: "My Agent",
    origin: "custom",
    launch: { executable: "my-agent", args: [] },
    resume: { executable: "my-agent", args: ["--resume={sessionId}"] }
  }).success).toBe(false);
  expect(customHarnessDefinitionSchema.safeParse({
    id: "my-agent",
    displayName: "My Agent",
    origin: "custom",
    launch: { executable: "my-agent", args: [] },
    environment: { TOKEN: { kind: "secret", secretId: "018f1f34-7000-7000-8000-000000000001" } }
  }).success).toBe(false);
  expect(customHarnessDefinitionSchema.safeParse({
    id: "my-agent",
    displayName: "My Agent",
    origin: "custom",
    launch: { executable: "my-agent", args: [] },
    resume: null
  }).success).toBe(true);
});

test("native id rejects controls, leading dash, empties, and oversize", () => {
  expect(() => assertNativeSessionId("-evil")).toThrow();
  expect(() => assertNativeSessionId("a\nb")).toThrow();
  expect(() => assertNativeSessionId("")).toThrow();
  expect(() => assertNativeSessionId("x".repeat(513))).toThrow();
  expect(assertNativeSessionId("thread_abc")).toBe("thread_abc");
});
