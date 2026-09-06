export type AuthenticatedGitFailureKind = "authentication" | "remote-source" | "internal";

export interface AuthenticatedGitFailureResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut?: boolean;
}

const AUTHENTICATION_FAILURE_PATTERN = /authentication failed|could not read Username|invalid username|HTTP 401|HTTP 403|access denied/iu;
const REMOTE_TRANSPORT_FAILURE_PATTERN = /could not resolve (?:host|proxy)|name or service not known|temporary failure in name resolution|failed to connect|could not connect to server|connection (?:refused|timed out|reset by peer|closed|terminated)|remote end hung up unexpectedly|unexpected disconnect while reading sideband packet|network is unreachable|no route to host|(?:gnutls|openssl|tls|ssl)[^\n]*(?:handshake|connect(?:ion)?|transport|error)|the requested URL returned error:\s*5\d\d|rpc failed;\s*http\s+5\d\d/iu;

export function classifyAuthenticatedGitFailure(result: AuthenticatedGitFailureResult): AuthenticatedGitFailureKind {
  if (result.timedOut === true) return "remote-source";
  if (result.signal !== null) return "internal";
  if (AUTHENTICATION_FAILURE_PATTERN.test(result.stderr)) return "authentication";
  if (REMOTE_TRANSPORT_FAILURE_PATTERN.test(result.stderr)) return "remote-source";
  return "internal";
}
