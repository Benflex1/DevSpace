export const CODEX_HARNESS_ID = "codex";
export const HARNESS_SLOT_ENV = "/opt/devspace/harness-home";

export const CODEX_PRESET = {
  id: CODEX_HARNESS_ID,
  launch: { executable: "codex", args: [] as string[] },
  resume: { executable: "codex", args: ["resume", "{sessionId}"] },
  privateState: { kind: "dedicated-home" as const, env: { CODEX_HOME: HARNESS_SLOT_ENV } }
};
