export function harnessResumeControlEnabled(session: { resume?: boolean } | null): boolean {
  return session?.resume === true;
}
