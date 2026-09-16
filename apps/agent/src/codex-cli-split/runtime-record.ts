import * as z from "zod";
import { projectOptionsRevisionHashSchema, uuidV7Schema } from "@devspace/contracts";
import {
  fileIdentitySchema,
  identitiesEqual,
  type FileIdentity
} from "../private-state.js";
import type { CodexSplitTransportSecurity } from "./transport.js";

const dockerIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u);
const dockerNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]+$/u);
const imageIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const endpointUrlSchema = z.string().regex(/^ws:\/\/codex-executor:[1-9][0-9]{0,4}$/u).refine((value) => {
  const port = Number(value.slice(value.lastIndexOf(":") + 1));
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}, "Executor endpoint port is invalid");
const timestampSchema = z.string().datetime({ offset: true });

const transportSecuritySchema = z.enum([
  "protocol-authenticated", "private-network-only", "unproven"
] satisfies readonly CodexSplitTransportSecurity[]);

export const codexSplitSessionRecordSchema = z.strictObject({
  nativeSessionId: uuidV7Schema,
  controlContainerId: dockerIdSchema,
  controlExecId: dockerIdSchema,
  homeIdentity: fileIdentitySchema,
  state: z.enum(["starting", "live", "stopped", "ambiguous"]),
  startedAt: timestampSchema,
  stoppedAt: timestampSchema.nullable()
}).superRefine((session, context) => {
  if ((session.state === "starting" || session.state === "live") && session.stoppedAt !== null) {
    context.addIssue({ code: "custom", path: ["stoppedAt"], message: "Live sessions cannot have a stop time" });
  }
  if ((session.state === "stopped" || session.state === "ambiguous") && session.stoppedAt === null) {
    context.addIssue({ code: "custom", path: ["stoppedAt"], message: "Stopped sessions require a stop time" });
  }
});
export type CodexSplitSessionRecord = z.infer<typeof codexSplitSessionRecordSchema>;

const executionNetworkRecordSchema = z.strictObject({
  id: dockerIdSchema,
  name: dockerNameSchema,
  role: z.literal("execution"),
  internal: z.literal(true),
  defaultRoute: z.literal(false)
});

const controlEgressNetworkRecordSchema = z.strictObject({
  id: dockerIdSchema,
  name: dockerNameSchema,
  role: z.literal("control-egress"),
  internal: z.literal(false),
  defaultRoute: z.literal(true)
});

export const codexSplitRuntimeRecordSchema = z.strictObject({
  version: z.literal(1),
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  revisionId: uuidV7Schema,
  runtimePlanHash: projectOptionsRevisionHashSchema,
  generation: z.number().int().positive(),
  networks: z.strictObject({
    execution: executionNetworkRecordSchema,
    controlEgress: controlEgressNetworkRecordSchema
  }).superRefine((networks, context) => {
    if (networks.execution.id === networks.controlEgress.id || networks.execution.name === networks.controlEgress.name) {
      context.addIssue({ code: "custom", message: "Split network roles must be distinct" });
    }
  }),
  executor: z.strictObject({
    id: dockerIdSchema,
    imageId: imageIdSchema,
    endpointUrl: endpointUrlSchema,
    transportSecurity: transportSecuritySchema
  }),
  control: z.strictObject({ id: dockerIdSchema, homeBinding: z.literal("owner-default") }),
  sessions: z.array(codexSplitSessionRecordSchema)
}).superRefine((record, context) => {
  const live = new Set<string>();
  for (const [index, session] of record.sessions.entries()) {
    if (session.state !== "starting" && session.state !== "live") continue;
    if (live.has(session.nativeSessionId)) {
      context.addIssue({ code: "custom", path: ["sessions", index, "nativeSessionId"], message: "session-live-duplicate" });
    }
    live.add(session.nativeSessionId);
  }
  const endpointPort = Number(record.executor.endpointUrl.slice(record.executor.endpointUrl.lastIndexOf(":") + 1));
  if (!Number.isSafeInteger(endpointPort) || endpointPort < 1 || endpointPort > 65535) {
    context.addIssue({ code: "custom", path: ["executor", "endpointUrl"], message: "Executor endpoint port is invalid" });
  }
});
export type CodexSplitRuntimeRecord = z.infer<typeof codexSplitRuntimeRecordSchema>;

export function parseCodexSplitRuntimeRecord(input: unknown): CodexSplitRuntimeRecord {
  const result = codexSplitRuntimeRecordSchema.safeParse(input);
  if (!result.success) {
    const duplicate = result.error.issues.some((issue) => issue.message === "session-live-duplicate");
    throw new Error(duplicate ? "codex-split-session-live" : "codex-split-runtime-record", { cause: result.error });
  }
  return result.data;
}

export function assertCodexSplitHomeIdentity(expected: FileIdentity, observed: FileIdentity): void {
  if (!identitiesEqual(expected, observed)) throw new Error("codex-split-home-identity");
}

export function assertCodexSplitSessionConcurrency(record: CodexSplitRuntimeRecord, nativeSessionId: string): void {
  uuidV7Schema.parse(nativeSessionId);
  if (record.sessions.some((session) => session.nativeSessionId === nativeSessionId
    && (session.state === "starting" || session.state === "live"))) {
    throw new Error("codex-split-session-live");
  }
}
