import * as z from "zod";

export const CODEX_BASELINE_CLI_VERSION = "0.145.0" as const;
export const CODEX_BASELINE_VERSION_OUTPUT = "codex-cli 0.145.0" as const;

export const codexAppServerProtocolMethods = Object.freeze({
  clientRequests: Object.freeze([
    "initialize",
    "thread/start",
    "thread/resume",
    "turn/start",
    "turn/interrupt"
  ]),
  clientNotifications: Object.freeze(["initialized"]),
  serverNotifications: Object.freeze([
    "thread/started",
    "turn/started",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "turn/completed"
  ]),
  stableServerRequests: Object.freeze([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval"
  ]),
  experimentalServerRequests: Object.freeze([
    "item/tool/requestUserInput"
  ])
} as const);

export const codexAppServerFixtureManifestSchema = z.strictObject({
  baselineVersion: z.literal("0.145.0"),
  cliVersion: z.literal(CODEX_BASELINE_CLI_VERSION),
  versionOutput: z.literal(CODEX_BASELINE_VERSION_OUTPUT),
  cliBinarySha256: z.string().regex(/^[0-9a-f]{64}$/u),
  generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  stableGenerationCommand: z.literal(
    "codex app-server generate-json-schema --out <directory>"
  ),
  experimentalGenerationCommand: z.literal(
    "codex app-server generate-json-schema --experimental --out <directory>"
  ),
  transport: z.strictObject({
    mode: z.literal("stdio-jsonl"),
    tty: z.literal(false),
    stdout: z.literal("protocol-only"),
    stderr: z.literal("private-diagnostics")
  }),
  officialSource: z.string().url(),
  upstreamLicense: z.literal("Apache-2.0"),
  fixtures: z.array(z.strictObject({
    scope: z.enum(["stable-default", "experimental"]),
    file: z.string().regex(/^(?:stable|experimental)\/[A-Za-z0-9]+\.json$/u),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u)
  })).length(5),
  methods: z.strictObject({
    clientRequests: z.tuple([
      z.literal("initialize"),
      z.literal("thread/start"),
      z.literal("thread/resume"),
      z.literal("turn/start"),
      z.literal("turn/interrupt")
    ]),
    clientNotifications: z.tuple([z.literal("initialized")]),
    serverNotifications: z.tuple([
      z.literal("thread/started"),
      z.literal("turn/started"),
      z.literal("item/started"),
      z.literal("item/completed"),
      z.literal("item/agentMessage/delta"),
      z.literal("turn/completed")
    ]),
    stableServerRequests: z.tuple([
      z.literal("item/commandExecution/requestApproval"),
      z.literal("item/fileChange/requestApproval")
    ]),
    experimentalServerRequests: z.tuple([
      z.literal("item/tool/requestUserInput")
    ])
  })
});

/**
 * Agent-private adapter launch authority. No member of this type is a public
 * Agent/Web or browser contract.
 */
export interface CodexAppServerPrivateLaunch {
  readonly executableIdentity: "deployment-profile-pinned-codex";
  readonly cliVersion: typeof CODEX_BASELINE_CLI_VERSION;
  readonly launchMode: "app-server-stdio";
  readonly tty: false;
  readonly workspaceDirectory: string;
  readonly fixedArguments: readonly string[];
  readonly fixedEnvironment: Readonly<Record<string, string>>;
  readonly credentialSourceHandle: string;
  readonly experimentalApi: true;
}

/**
 * Raw JSON-RPC IDs and provider-native thread/turn/item identities live only in
 * the Agent adapter and its private ownership record.
 */
export interface CodexAppServerPrivateCorrelation {
  readonly providerThreadId: string;
  readonly providerTurnId: string | null;
  readonly providerItemId: string | null;
  readonly jsonRpcRequestId: string | number | null;
}
