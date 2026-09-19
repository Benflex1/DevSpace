import * as z from "zod";

export const SESSION_ID_PLACEHOLDER = "{sessionId}";

export const harnessArgvSchema = z.strictObject({
  executable: z.string().regex(/^[A-Za-z0-9._+-]+$/u).max(128),
  args: z.array(z.string().min(1).max(4096)).max(32)
});
export type HarnessArgv = z.infer<typeof harnessArgvSchema>;

export type ResumeTemplateClass =
  | { kind: "none" }
  | { kind: "provider-handled" }
  | { kind: "native-id" };

function placeholderCount(args: readonly string[]): number {
  let count = 0;
  for (const arg of args) {
    if (arg === SESSION_ID_PLACEHOLDER) count += 1;
    else if (arg.includes(SESSION_ID_PLACEHOLDER)) {
      throw new Error("resume argv placeholder must be a whole token");
    }
  }
  return count;
}

export function parseResumeArgv(resume: HarnessArgv): ResumeTemplateClass {
  harnessArgvSchema.parse(resume);
  const count = placeholderCount(resume.args);
  if (count === 0) return { kind: "provider-handled" };
  if (count === 1) return { kind: "native-id" };
  throw new Error("resume argv may contain at most one {sessionId} placeholder");
}

export function classifyResumeArgv(resume: HarnessArgv | null): ResumeTemplateClass {
  if (resume === null) return { kind: "none" };
  return parseResumeArgv(resume);
}

export function assertNativeSessionId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 512) throw new Error("native session id length");
  if (trimmed.startsWith("-")) throw new Error("native session id leading dash");
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) throw new Error("native session id control");
  }
  if (trimmed.includes("\0")) throw new Error("native session id nul");
  return trimmed;
}

export function substituteResumeArgv(template: HarnessArgv, nativeSessionId: string): HarnessArgv {
  const parsed = parseResumeArgv(template);
  if (parsed.kind !== "native-id") throw new Error("resume argv placeholder");
  const id = assertNativeSessionId(nativeSessionId);
  return {
    executable: template.executable,
    args: template.args.map((arg) => arg === SESSION_ID_PLACEHOLDER ? id : arg)
  };
}

export function resumeCapability(input: {
  resume: HarnessArgv | null;
  nativeSessionId: string | null;
}): boolean {
  const classified = classifyResumeArgv(input.resume);
  if (classified.kind === "none") return false;
  if (classified.kind === "provider-handled") return true;
  return input.nativeSessionId !== null;
}
