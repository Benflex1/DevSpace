import { chmod } from "node:fs/promises";
import path from "node:path";
import {
  assertContained,
  establishPinnedDirectory,
  identitiesEqual,
  lstatIdentity,
  pinExistingDirectory,
  type FileIdentity
} from "../private-state.js";

export const CODEX_NATIVE_ACCOUNT_BINDING = "owner-default" as const;
const NATIVE_HOME_MODE = 0o700;

export interface CodexNativeHomeBinding {
  readonly accountBinding: typeof CODEX_NATIVE_ACCOUNT_BINDING;
  readonly homePath: string;
  readonly mountTarget: "/codex-home";
  readonly identity: FileIdentity;
  readonly ownerUid: number;
  readonly ownerGid: number;
}

export interface WorkspaceGitAdministrationBinding {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly worktreePath: string;
  readonly repositoryPath: string;
  readonly administrationPath: string;
  readonly worktreeIdentity: FileIdentity;
  readonly repositoryIdentity: FileIdentity;
  readonly administrationIdentity: FileIdentity;
}

function assertPath(value: string, errorCode: string): string {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(errorCode);
  return path.resolve(value);
}

export function nativeCodexHomePath(stateRoot: string): string {
  const root = assertPath(stateRoot, "native-home-state-root-invalid");
  return assertContained(root, path.join(root, "codex-homes", CODEX_NATIVE_ACCOUNT_BINDING));
}

function ownerNumber(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name}-invalid`);
  return value;
}

export async function ensureNativeCodexHome(input: {
  readonly homePath: string;
  readonly ownerUid: number;
  readonly ownerGid: number;
}): Promise<CodexNativeHomeBinding> {
  const homePath = assertPath(input.homePath, "native-home-path-invalid");
  const ownerUid = ownerNumber(input.ownerUid, "native-home-owner-uid");
  const ownerGid = ownerNumber(input.ownerGid, "native-home-owner-gid");
  const before = await lstatIdentity(homePath);
  if (before === null) {
    try {
      await establishPinnedDirectory(homePath);
      await chmod(homePath, NATIVE_HOME_MODE);
    } catch (error) {
      throw new Error("native-home-establish-failed", { cause: error });
    }
  } else {
    if (!before.stats.isDirectory() || before.stats.isSymbolicLink()) throw new Error("native-home-path-invalid");
    await pinExistingDirectory(homePath).catch((error) => { throw new Error("native-home-path-invalid", { cause: error }); });
  }
  const pinned = await pinExistingDirectory(homePath).catch((error) => {
    throw new Error("native-home-path-invalid", { cause: error });
  });
  const stats = (await lstatIdentity(pinned.path))?.stats;
  if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink()) throw new Error("native-home-path-invalid");
  if (Number(stats.uid) !== ownerUid || Number(stats.gid) !== ownerGid) throw new Error("native-home-owner-mismatch");
  if (Number(stats.mode & 0o777n) !== NATIVE_HOME_MODE) throw new Error("native-home-mode-mismatch");
  if (!identitiesEqual(pinned.identity, (await lstatIdentity(homePath))!.identity)) throw new Error("native-home-identity-mismatch");
  return {
    accountBinding: CODEX_NATIVE_ACCOUNT_BINDING,
    homePath: pinned.path,
    mountTarget: "/codex-home",
    identity: pinned.identity,
    ownerUid,
    ownerGid
  };
}
