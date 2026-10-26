export const CODEX_HARNESS_ID = "codex";
export const HARNESS_SLOT_ENV = "/opt/devspace/harness-home";

export const CODEX_PRESET = {
  id: CODEX_HARNESS_ID,
  launch: { executable: "codex", args: ["--yolo", "--no-daemon", "--no-alt-screen"] },
  resume: { executable: "codex", args: ["--yolo", "--no-daemon", "--no-alt-screen", "resume", "{sessionId}"] },
  privateState: { kind: "dedicated-home" as const, env: { CODEX_HOME: HARNESS_SLOT_ENV } }
};
