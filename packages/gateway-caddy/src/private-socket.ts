import { lstat, open, readFile, unlink, type FileHandle } from "node:fs/promises";

type FileIdentity = { readonly dev: bigint; readonly ino: bigint };

function fileIdentity(stats: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  return { dev: BigInt(stats.dev), ino: BigInt(stats.ino) };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function unlinkOwnedLock(lockPath: string, ownership: FileIdentity): Promise<void> {
  try {
    const current = await lstat(lockPath);
    if (current.isFile() && sameFile(ownership, fileIdentity(current))) await unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  let current;
  try { current = await lstat(lockPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!current.isFile()) throw new Error("Refusing to replace an uncertain private socket lifecycle lock.");
  const ownership = fileIdentity(current);
  let verified;
  try { verified = await lstat(lockPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!verified.isFile() || !sameFile(ownership, fileIdentity(verified))) {
    throw new Error("The private socket lifecycle lock changed during stale ownership checking.");
  }
  await unlink(lockPath);
}

export interface PrivateSocketLifecycleLock {
  release(): Promise<void>;
}

/**
 * Serializes ownership publication and cleanup for one administrator-owned
 * private socket pathname. The lock is deliberately held until the listener
 * has closed and its identity-checked socket cleanup has completed.
 */
export async function acquirePrivateSocketLifecycleLock(
  socketPath: string,
  description = "private socket"
): Promise<PrivateSocketLifecycleLock> {
  const lockPath = `${socketPath}.lock`;
  for (;;) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, "wx", 0o660);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { readonly pid: number };
      try { owner = JSON.parse(await readFile(lockPath, "utf8")) as { readonly pid: number }; }
      catch (error) { throw new Error(`Unable to prove ownership of the ${description} lifecycle lock.`, { cause: error }); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || processIsAlive(owner.pid)) {
        throw new Error(`An active ${description} lifecycle already owns the socket path.`, { cause: error });
      }
      await removeStaleLock(lockPath);
      continue;
    }

    const ownership = fileIdentity(await lstat(lockPath));
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }), "utf8");
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlinkOwnedLock(lockPath, ownership).catch(() => undefined);
      throw error;
    }
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        try { await unlinkOwnedLock(lockPath, ownership); }
        finally { await handle.close(); }
      }
    };
  }
}
