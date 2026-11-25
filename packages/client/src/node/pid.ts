// SPDX-License-Identifier: MPL-2.0

/** True when a process with this pid exists (signal 0 only checks). `EPERM` means it exists. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown } | undefined)?.code === 'EPERM';
  }
}
