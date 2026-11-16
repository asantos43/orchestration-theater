// SPDX-License-Identifier: MPL-2.0

/** Awaits a promise that must reject and returns the rejection; fails the test if it resolves. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject, but it resolved');
}

/** A promise settled from the outside, to hold a test body at a known point. */
export function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Lets already-queued promise continuations run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 5);
  });
}
