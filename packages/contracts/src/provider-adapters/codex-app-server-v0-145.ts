import * as z from "zod";

export const CODEX_APP_SERVER_CLI_VERSION = "0.145.0" as const;
export const CODEX_APP_SERVER_VERSION_OUTPUT = "codex-cli 0.145.0" as const;
export const CODEX_APP_SERVER_SCHEMA_SHA256 =
  "eaf8f9774dbad397818fa64241b9fcd4f894bde3d852d3c8948c68f07975b6ff" as const;

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
  cliVersion: z.literal(CODEX_APP_SERVER_CLI_VERSION),
  versionOutput: z.literal(CODEX_APP_SERVER_VERSION_OUTPUT),
  generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  generator: z.literal("codex app-server generate-json-schema --out <directory>"),
  generatorExperimentalFlag: z.literal(false),
  transport: z.strictObject({
    mode: z.literal("stdio-jsonl"),
    tty: z.literal(false),
    stdout: z.literal("protocol-only"),
    stderr: z.literal("private-diagnostics")
  }),
  officialSource: z.string().url(),
  aggregateV2Schema: z.strictObject({
    file: z.literal("codex_app_server_protocol.v2.schemas.json"),
    bytes: z.literal(491_906),
    sha256: z.literal(CODEX_APP_SERVER_SCHEMA_SHA256)
  }),
  componentHashes: z.strictObject({
    ClientRequest: z.literal("44615d6348466a48c05228d99eb555d1d655aaffc1474fb0abdd7f4945502e35"),
    ClientNotification: z.literal("a30b3041578845b11add3d07d5a63cd3a12d5d126e87b8c591862b4aeb68d97c"),
    ServerRequest: z.literal("177f8b7de9dd8ce2055c56a5fd22dbc6ec24e2a4d706d08fef9f5ad4effe71f6"),
    ServerNotification: z.literal("0c7b42c4e2cffc419bf753ea5a34a56b2965219c2087304993bce97cf978f915"),
    ToolRequestUserInputParams: z.literal("21e569e32c05d51c1ee5e587730c182b911ede97a4df267f6e4ef24e1717f34e")
  }),
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
  readonly cliVersion: typeof CODEX_APP_SERVER_CLI_VERSION;
  readonly launchMode: "app-server-stdio";
  readonly tty: false;
  readonly workspaceDirectory: string;
  readonly fixedArguments: readonly string[];
  readonly fixedEnvironment: Readonly<Record<string, string>>;
  readonly credentialSourceHandle: string;
  readonly experimentalApi: false;
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
